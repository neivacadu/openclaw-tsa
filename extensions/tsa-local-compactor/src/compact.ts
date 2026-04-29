/**
 * tsa-local-compactor — heuristic local compactor (pure logic).
 *
 * Pure compact() pipeline + helpers. Zero LLM, zero IO. Imported by:
 *   - src/plugin.ts (SDK register adapter, before_prompt_build)
 *   - src/smoke.test.ts (offline smoke tests, 4 asserts)
 *
 * Algorithm port of code-claude/rust/crates/runtime/src/compact.rs adapted
 * for ACE multi-agent cascades (JOKER/HERO/CREATOR/HUNTER).
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  text?: string;
  toolName?: string;
  input?: string;
  output?: string;
}

export interface CompactConfig {
  preserveRecent: number; // default 8
  maxTokens: number; // default 15_000
  compactTarget: number; // default 6_000
  mode: "heuristic" | "llm" | "off";
  logBeforeAfter: boolean;
}

export const DEFAULT_CONFIG: CompactConfig = {
  preserveRecent: 8,
  maxTokens: 15000,
  compactTarget: 6000,
  mode: "heuristic",
  logBeforeAfter: true,
};

const SUMMARY_OPEN = "<summary>";
const SUMMARY_CLOSE = "</summary>";
const PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. ";

// ----- helpers -----

function firstText(m: Message): string | undefined {
  if (m.text && m.text.trim()) return m.text;
  if (m.output && m.output.trim()) return m.output;
  if (m.input && m.input.trim()) return m.input;
  return undefined;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export function estimateTokens(m: Message): number {
  const len =
    (m.text ?? "").length +
    (m.input ?? "").length +
    (m.output ?? "").length +
    (m.toolName ?? "").length;
  return Math.floor(len / 4) + 1;
}

function hasPriorSummary(msgs: Message[]): boolean {
  if (msgs.length === 0) return false;
  const head = msgs[0];
  return head.role === "system" && !!head.text && head.text.includes(SUMMARY_OPEN);
}

function extractPriorSummary(m: Message | undefined): string | null {
  if (!m || !m.text) return null;
  const i = m.text.indexOf(SUMMARY_OPEN);
  const j = m.text.indexOf(SUMMARY_CLOSE);
  if (i < 0 || j < 0 || j <= i) return null;
  return m.text.slice(i + SUMMARY_OPEN.length, j).trim();
}

// ----- extraction heuristics -----

export function extractLastUserRequests(msgs: Message[], n = 3, truncTo = 200): string[] {
  return msgs
    .filter((m) => m.role === "user" && firstText(m))
    .slice(-n)
    .map((m) => truncate(firstText(m)!, truncTo));
}

export function extractPendingWork(msgs: Message[]): string[] {
  const re = /\b(todo|next|pending|aguarda|falta|follow ?up|remaining)\b/i;
  const hits: string[] = [];
  for (let i = msgs.length - 1; i >= 0 && hits.length < 3; i--) {
    const t = firstText(msgs[i]);
    if (t && re.test(t)) hits.push(truncate(t.trim(), 200));
  }
  return hits.reverse();
}

export function extractKeyFiles(msgs: Message[]): string[] {
  const re =
    /(\/opt\/[\w./-]+|\/home\/[\w./-]+|[\w./-]+\.(?:ts|tsx|js|json|yaml|yml|md|rs|py|sh))/g;
  const set = new Set<string>();
  for (const m of msgs) {
    const blob = (m.text ?? "") + " " + (m.input ?? "") + " " + (m.output ?? "");
    for (const match of blob.matchAll(re)) set.add(match[1]);
  }
  return [...set].sort().slice(0, 8);
}

export function inferCurrentWork(msgs: Message[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant") continue;
    const t = firstText(msgs[i]);
    if (t && t.trim()) return truncate(t, 200);
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = firstText(msgs[i]);
    if (t && t.trim()) return truncate(t, 200);
  }
  return null;
}

function countByRole(msgs: Message[]): Record<Role, number> {
  const c: Record<Role, number> = { system: 0, user: 0, assistant: 0, tool: 0 };
  for (const m of msgs) c[m.role]++;
  return c;
}

function toolsUsed(msgs: Message[]): string[] {
  const set = new Set<string>();
  for (const m of msgs) if (m.toolName) set.add(m.toolName);
  return [...set].sort().slice(0, 12);
}

// ----- summary formatting -----

export function formatSummary(
  removed: Message[],
  priorSummary: string | null,
  rangeLabel: string,
): string {
  const counts = countByRole(removed);
  const tools = toolsUsed(removed);
  const lastReqs = extractLastUserRequests(removed);
  const pending = extractPendingWork(removed);
  const keyFiles = extractKeyFiles(removed);
  const current = inferCurrentWork(removed);

  const lines: string[] = [];
  lines.push(SUMMARY_OPEN);

  if (priorSummary) {
    lines.push("## Previously compacted context");
    lines.push(priorSummary);
    lines.push("");
  }

  lines.push(`## Newly compacted (${rangeLabel})`);
  lines.push(`- ${counts.user} user, ${counts.assistant} assistant, ${counts.tool} tool messages`);
  if (tools.length) lines.push(`- Tools used: ${tools.join(", ")}`);
  if (lastReqs.length) {
    lines.push("- Last user requests:");
    for (const r of lastReqs) lines.push(`  - "${r}"`);
  }
  if (pending.length) {
    lines.push("- Pending:");
    for (const p of pending) lines.push(`  - ${p}`);
  }
  if (keyFiles.length) lines.push(`- Key files: ${keyFiles.join(", ")}`);
  if (current) lines.push(`- Current work: ${current}`);

  lines.push(SUMMARY_CLOSE);
  return lines.join("\n");
}

// ----- main entrypoint -----

export function shouldCompact(msgs: Message[], cfg: CompactConfig): boolean {
  if (cfg.mode !== "heuristic") return false;
  const start = hasPriorSummary(msgs) ? 1 : 0;
  const slice = msgs.slice(start);
  if (slice.length <= cfg.preserveRecent) return false;
  const tokens = slice.reduce((s, m) => s + estimateTokens(m), 0);
  return tokens >= cfg.maxTokens;
}

export function compact(messages: Message[], cfg: CompactConfig = DEFAULT_CONFIG): Message[] {
  if (cfg.mode === "off") return messages;
  if (!shouldCompact(messages, cfg)) return messages;

  const priorSummary = hasPriorSummary(messages) ? extractPriorSummary(messages[0]) : null;
  const prefixLen = priorSummary ? 1 : 0;
  const keepFrom = Math.max(prefixLen, messages.length - cfg.preserveRecent);
  const removed = messages.slice(prefixLen, keepFrom);
  const preserved = messages.slice(keepFrom);

  const rangeLabel = `${prefixLen + 1}-${keepFrom}`;
  const summaryBlock = formatSummary(removed, priorSummary, rangeLabel);

  const sysMsg: Message = {
    role: "system",
    text: PREAMBLE + summaryBlock,
  };

  if (cfg.logBeforeAfter) {
    const tIn = messages.reduce((s, m) => s + estimateTokens(m), 0);
    const out = [sysMsg, ...preserved];
    const tOut = out.reduce((s, m) => s + estimateTokens(m), 0);
    // eslint-disable-next-line no-console
    console.log(
      `compactor: in=${tIn} msgs=${messages.length} out=${tOut} msgs=${out.length} saved=${tIn - tOut} mode=${cfg.mode}`,
    );
  }

  return [sysMsg, ...preserved];
}
