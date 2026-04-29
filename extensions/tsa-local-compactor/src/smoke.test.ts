/**
 * Smoke test offline — sem deploy, sem rede, sem LLM.
 *
 * Run: npm run build && npm test
 *
 * 4 asserts:
 *   1. 200 mensagens mock → output.length ≤ preserveRecent + 1
 *   2. estimated_tokens(output) < maxTokens
 *   3. idempotente: compact(compact(x)) não duplica <summary>
 *   4. last 3 messages preserved verbatim (deep equal)
 */

import { compact, estimateTokens, DEFAULT_CONFIG, type Message, type Role } from "./compact.js";

function fail(label: string, detail: string): never {
  // eslint-disable-next-line no-console
  console.error(`FAIL ${label}: ${detail}`);
  process.exit(1);
}

function ok(label: string): void {
  // eslint-disable-next-line no-console
  console.log(`PASS ${label}`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeMockMessages(n: number, seed = 42): Message[] {
  const rng = rand(seed);
  const roles: Role[] = ["user", "assistant", "tool"];
  const tools = ["sessions_spawn", "gold_review", "telegram_send", "kanban_move"];
  const paths = [
    "/opt/openclaw-tsa-git/plugins/foo.ts",
    "/home/ace-tsia/.openclaw/openclaw.json",
    "rules/policy/cascade.yaml",
    "src/runtime/compact.rs",
  ];
  const verbs = ["rodar", "ajustar", "deploy", "review", "sync", "aguarda", "next"];

  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    const role = roles[Math.floor(rng() * roles.length)];
    const verb = verbs[Math.floor(rng() * verbs.length)];
    const path = paths[Math.floor(rng() * paths.length)];
    const filler = "x".repeat(1800 + Math.floor(rng() * 400));
    const text = `[msg ${i}] ${verb} em ${path} — ${filler}`;
    if (role === "tool") {
      out.push({
        role,
        toolName: tools[Math.floor(rng() * tools.length)],
        output: text,
      });
    } else {
      out.push({ role, text });
    }
  }
  return out;
}

function totalTokens(msgs: Message[]): number {
  return msgs.reduce((s, m) => s + estimateTokens(m), 0);
}

function countSummaryTags(msgs: Message[]): number {
  let c = 0;
  for (const m of msgs) {
    const t = m.text ?? "";
    const matches = t.match(/<summary>/g);
    if (matches) c += matches.length;
  }
  return c;
}

// ----- test runs -----

const cfg = { ...DEFAULT_CONFIG, logBeforeAfter: false };
const msgs = makeMockMessages(200);
const tIn = totalTokens(msgs);
// eslint-disable-next-line no-console
console.log(`mock: ${msgs.length} messages, ~${tIn} tokens estimated`);

const out = compact(msgs, cfg);

// 1. shape
if (out.length > cfg.preserveRecent + 1) {
  fail("1-shape", `output.length=${out.length}, expected ≤ ${cfg.preserveRecent + 1}`);
}
ok(`1-shape (output.length=${out.length})`);

// 2. token budget
const tOut = totalTokens(out);
if (tOut >= cfg.maxTokens) {
  fail("2-tokens", `tOut=${tOut} >= maxTokens=${cfg.maxTokens}`);
}
ok(`2-tokens (tOut=${tOut} < ${cfg.maxTokens})`);

// 3. idempotence — compact(compact(x)) no duplica <summary>
const out2 = compact(out, cfg);
const tags1 = countSummaryTags(out);
const tags2 = countSummaryTags(out2);
if (tags1 !== 1) fail("3-idempotence", `first pass tags=${tags1}, expected 1`);
if (tags2 !== tags1) {
  fail("3-idempotence", `re-run tags=${tags2}, expected ${tags1}`);
}
ok(`3-idempotence (tags=${tags2}, stable)`);

// 4. last 3 preserved verbatim
const inputLast3 = msgs.slice(-3);
const outputLast3 = out.slice(-3);
if (!deepEqual(inputLast3, outputLast3)) {
  fail(
    "4-preserve",
    `last 3 not verbatim:\nin=${JSON.stringify(inputLast3).slice(0, 200)}\nout=${JSON.stringify(outputLast3).slice(0, 200)}`,
  );
}
ok("4-preserve (last 3 verbatim)");

// eslint-disable-next-line no-console
console.log("\nALL SMOKE TESTS PASSED");
process.exit(0);
