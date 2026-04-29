/**
 * tsa-pt-br-validator — logica pura.
 *
 * Sem efeito colateral: scoreText / extractText / looksLikePortuguese.
 * O plugin.ts registra o hook e usa essas funcoes; smoke.test.ts testa
 * direto sem precisar do runtime SDK.
 *
 * Heuristica leve em 3 camadas:
 *   1. Detecta texto pt-BR (palavras comuns: que/e/para/com/nao/uma/dos)
 *   2. Palavras vigiadas sem acento (regex fail-list)
 *   3. Anglicismos sem traducao em parenteses
 *   4. Concordancia basica (artigo/substantivo numero)
 *
 * Score 0-10. < threshold (default 7) -> log/deny.
 */
import { readFileSync, existsSync } from "node:fs";

export interface ValidatorConfig {
  monitorOnly: boolean;
  scoreThreshold: number;
  minTextLength: number;
  watchedWordsPath: string;
  anglicismsPath: string;
  logPath: string;
}

export const DEFAULT_VALIDATOR_CONFIG: ValidatorConfig = {
  monitorOnly: true,
  scoreThreshold: 7,
  minTextLength: 200,
  watchedWordsPath:
    "/home/ace-tsia/.openclaw/workspace/skills/0-revisao-pt-br/knowledge/palavras-vigiadas.md",
  anglicismsPath:
    "/home/ace-tsia/.openclaw/workspace/skills/0-revisao-pt-br/knowledge/anglicismos-traducoes.md",
  logPath: "/var/log/tsa-pt-br-validator.jsonl",
};

const PT_MARKERS = [
  " que ",
  " e ",
  " para ",
  " com ",
  " nao ",
  " não ",
  " uma ",
  " dos ",
  " do ",
  " da ",
  " no ",
  " na ",
  " você ",
  " voce ",
  " ser ",
  " ter ",
];

export function looksLikePortuguese(text: string): boolean {
  const lower = " " + text.toLowerCase() + " ";
  let hits = 0;
  for (const m of PT_MARKERS) if (lower.includes(m)) hits++;
  return hits >= 3;
}

export function loadWatchedWords(path: string): { wrong: string; right: string }[] {
  if (!existsSync(path)) return [];
  const txt = readFileSync(path, "utf8");
  const out: { wrong: string; right: string }[] = [];
  // Lines like:  diagnostico -> diagnóstico
  const re = /^([a-zA-ZçÇ]+)\s*->\s*([^\n]+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) !== null) {
    out.push({ wrong: m[1].trim(), right: m[2].trim() });
  }
  return out;
}

export function loadAnglicisms(path: string): { en: string; pt: string }[] {
  if (!existsSync(path)) return [];
  const txt = readFileSync(path, "utf8");
  const out: { en: string; pt: string }[] = [];
  const re = /^([a-zA-Z\-]+)\s*->\s*([^\n]+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt)) !== null) {
    out.push({ en: m[1].trim(), pt: m[2].trim() });
  }
  return out;
}

export interface Issue {
  kind: "missing_accent" | "untranslated_anglicism" | "agreement";
  detail: string;
  suggestion?: string;
}

export function findMissingAccents(
  text: string,
  list: { wrong: string; right: string }[],
): Issue[] {
  const out: Issue[] = [];
  for (const { wrong, right } of list) {
    const re = new RegExp(`\\b${wrong}\\b`, "gi");
    if (re.test(text)) {
      out.push({
        kind: "missing_accent",
        detail: `palavra "${wrong}" sem acentuacao correta`,
        suggestion: right,
      });
    }
  }
  return out;
}

export function findUntranslatedAnglicisms(
  text: string,
  list: { en: string; pt: string }[],
): Issue[] {
  const out: Issue[] = [];
  for (const { en, pt } of list) {
    const re = new RegExp(`\\b${en}\\b`, "gi");
    const matches = text.match(re);
    if (!matches) continue;
    const idx = text.search(re);
    const snippet = text.slice(idx, idx + 80);
    const hasParens = /\([^)]+\)/.test(snippet);
    if (!hasParens) {
      out.push({
        kind: "untranslated_anglicism",
        detail: `termo "${en}" sem traducao na primeira ocorrencia`,
        suggestion: `${en} (${pt})`,
      });
    }
  }
  return out;
}

export function findAgreementIssues(text: string): Issue[] {
  const out: Issue[] = [];
  const re = /\b(os|as|dos|das|nos|nas|aos|às)\s+([a-zçãéêíóôúâ]+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const noun = m[2].toLowerCase();
    if (/(s|ns|ões|ais|eis|ois|uis)$/.test(noun)) continue;
    if (noun.length < 4) continue;
    out.push({
      kind: "agreement",
      detail: `possivel concordancia: "${m[1]} ${noun}" — substantivo nao parece plural`,
    });
    if (out.length >= 5) break;
  }
  return out;
}

export function scoreText(text: string, cfg: ValidatorConfig): { score: number; issues: Issue[] } {
  const watched = loadWatchedWords(cfg.watchedWordsPath);
  const angl = loadAnglicisms(cfg.anglicismsPath);

  const issues: Issue[] = [
    ...findMissingAccents(text, watched),
    ...findUntranslatedAnglicisms(text, angl),
    ...findAgreementIssues(text),
  ];

  // Score: start at 10, deduct per issue with caps per category
  let score = 10;
  const accentCount = issues.filter((i) => i.kind === "missing_accent").length;
  const anglCount = issues.filter((i) => i.kind === "untranslated_anglicism").length;
  const agreeCount = issues.filter((i) => i.kind === "agreement").length;

  score -= Math.min(accentCount * 1.5, 5);
  score -= Math.min(anglCount * 1.0, 3);
  score -= Math.min(agreeCount * 0.5, 2);
  if (score < 0) score = 0;

  return { score, issues };
}

/**
 * Tools cuja saida geralmente tem texto longo:
 *   - Write   (toolInput.content)
 *   - Edit    (toolInput.new_string)
 *   - Bash    (heredoc dentro de toolInput.command)
 *   - WebFetch (resultado salvo, em event.result/output)
 */
const TEXT_PRODUCING_TOOLS = new Set(["Write", "Edit", "Bash", "WebFetch"]);

export function isTextProducingTool(toolName: string): boolean {
  return TEXT_PRODUCING_TOOLS.has(toolName);
}

export function extractText(
  toolName: string,
  params: Record<string, unknown> | undefined,
  result: unknown,
): string {
  if (toolName === "Write") return String(params?.content ?? "");
  if (toolName === "Edit") return String(params?.new_string ?? "");
  if (toolName === "Bash") {
    const cmd = String(params?.command ?? "");
    // Heredoc capture: <<EOF ... EOF
    const m = cmd.match(/<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\b/);
    if (m) return m[2];
    return "";
  }
  if (toolName === "WebFetch") {
    if (typeof result === "string") return result.slice(0, 4000);
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (typeof r.output === "string") return r.output.slice(0, 4000);
      if (typeof r.text === "string") return r.text.slice(0, 4000);
    }
    return "";
  }
  return "";
}

export type ValidationDecision = "allow" | "allow_warn" | "deny";

export interface ValidationResult {
  decision: ValidationDecision;
  score?: number;
  issues?: Issue[];
  reason?: string;
  suggestion?: string;
}

/**
 * Avalia um texto e devolve a decisao + payload pra logging.
 *
 * - texto curto / nao pt-BR  -> { decision: "allow" }
 * - score >= threshold       -> { decision: "allow", score }
 * - score < threshold + monitorOnly -> { decision: "allow_warn", score, issues }
 * - score < threshold + enforcement -> { decision: "deny", score, issues, reason, suggestion }
 */
export function validateText(text: string, cfg: ValidatorConfig): ValidationResult {
  if (text.length < cfg.minTextLength) return { decision: "allow" };
  if (!looksLikePortuguese(text)) return { decision: "allow" };

  const { score, issues } = scoreText(text, cfg);

  if (score >= cfg.scoreThreshold) {
    return { decision: "allow", score, issues };
  }

  if (cfg.monitorOnly) {
    return {
      decision: "allow_warn",
      score,
      issues,
      reason: "monitor-mode warning",
    };
  }

  // enforcement
  const suggestion = issues
    .filter((i) => i.suggestion)
    .map((i) => `- ${i.detail}: usar "${i.suggestion}"`)
    .join("\n");
  return {
    decision: "deny",
    score,
    issues,
    reason: `Texto pt-BR com score ${score.toFixed(1)}/10 (limite ${cfg.scoreThreshold}). Corrigir e re-tentar.`,
    suggestion,
  };
}
