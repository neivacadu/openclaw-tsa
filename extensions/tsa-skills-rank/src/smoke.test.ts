/**
 * smoke test tsa-skills-rank (SDK refactor)
 *
 * NAO TOCA producao. Usa /tmp + workspace mock.
 *
 * Cenarios (preservados do flat 0.1.0):
 *  T1 — index() popula DB com 50 skills mock
 *  T2 — rank("criar landing page") inclui landing-page-builder no top 5,
 *       NAO inclui skills aleatorias (random-noise-*)
 *  T3 — recordInvocation() 3x → use_count=3, last_used_at recente
 *  T4 — apos boost de uso, skill sobe no rank
 *  T5 — tool skill_search registrada via SDK harness devolve resultados com hint
 *  T6 — fallback by usage quando query vazia
 *  T7 — total_count = 50 e snapshot string contem header com total
 *
 * Cenario novo SDK:
 *  T8 — registerSkillsRanker engancha hooks before_prompt_build + after_tool_call,
 *       hook before_prompt_build retorna { appendSystemContext } com snapshot,
 *       hook after_tool_call ignora tools que nao sejam skill_invoke,
 *       hook after_tool_call processa skill_invoke e bumpa use_count.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SkillsRanker, registerSkillsRanker } from "./plugin.js";

/** Read use_count for a skill straight from SQLite, bypassing rank_cache. */
function rawUseCount(dbPath: string, skillId: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT use_count FROM skills WHERE skill_id = ?").get(skillId) as
      | { use_count: number }
      | undefined;
    return row?.use_count ?? -1;
  } finally {
    db.close();
  }
}

const ROOT = join(tmpdir(), `tsa-skills-rank-smoke-${Date.now()}`);
const SKILLS_DIR = join(ROOT, "skills");
const DB_PATH = join(ROOT, "skills.sqlite");

function setup(): void {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(SKILLS_DIR, { recursive: true });

  const skills: Array<{
    id: string;
    name: string;
    desc: string;
    cat: string;
    kw: string[];
  }> = [
    {
      id: "landing-page-builder",
      name: "Landing Page Builder",
      desc: "Cria landing pages com copy, design e formulario integrado.",
      cat: "marketing",
      kw: ["landing", "page", "copy", "lead"],
    },
    {
      id: "facebook-ads-launcher",
      name: "Facebook Ads Launcher",
      desc: "Configura e lanca campanhas de anuncios no Facebook Ads.",
      cat: "marketing",
      kw: ["facebook", "ads", "anuncio", "campanha"],
    },
    {
      id: "sql-query-optimizer",
      name: "SQL Query Optimizer",
      desc: "Analisa e otimiza queries SQL lentas.",
      cat: "data",
      kw: ["sql", "query", "performance"],
    },
    {
      id: "video-thumbnail-generator",
      name: "Video Thumbnail Generator",
      desc: "Gera thumbnails para videos do YouTube.",
      cat: "content",
      kw: ["thumbnail", "video", "youtube"],
    },
    {
      id: "deploy-runner",
      name: "Deploy Runner",
      desc: "Executa deploy automatizado em VPS Hetzner.",
      cat: "ops",
      kw: ["deploy", "vps", "hetzner"],
    },
  ];

  // Add 45 random noise skills pra ter 50 total
  for (let i = 0; i < 45; i++) {
    skills.push({
      id: `random-noise-${i}`,
      name: `Random Noise ${i}`,
      desc: `Skill aleatoria ${i} sem relacao com landing page.`,
      cat: i % 2 === 0 ? "misc" : "uncategorized",
      kw: [`noise${i}`, "random"],
    });
  }

  for (const s of skills) {
    const dir = join(SKILLS_DIR, s.cat, s.id);
    mkdirSync(dir, { recursive: true });
    const front = [
      "---",
      `id: ${s.id}`,
      `name: ${s.name}`,
      `description: ${s.desc}`,
      `category: ${s.cat}`,
      `keywords: [${s.kw.map((k) => `"${k}"`).join(", ")}]`,
      "---",
      "",
      `# ${s.name}`,
      "",
      s.desc,
    ].join("\n");
    writeFileSync(join(dir, "SKILL.md"), front);
  }
}

function cleanup(): void {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Tiny mock OpenClawPluginApi for T5 + T8. Mirrors the surface we declared in
// types/plugin-entry-stub.d.ts (api.on, api.registerTool, api.logger,
// api.pluginConfig).
// ---------------------------------------------------------------------------

interface RegisteredHook {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (event: any, ctx: any) => any;
}
interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, rawParams: Record<string, unknown>) => Promise<unknown>;
}

function makeMockApi(pluginConfig: Record<string, unknown>) {
  const hooks: RegisteredHook[] = [];
  const tools: RegisteredTool[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const api = {
    id: "tsa-skills-rank",
    name: "TSA Skills Rank (smoke)",
    description: "smoke",
    logger: {
      info: (msg: string) => logs.push({ level: "info", msg }),
      warn: (msg: string) => logs.push({ level: "warn", msg }),
      error: (msg: string) => logs.push({ level: "error", msg }),
      debug: (msg: string) => logs.push({ level: "debug", msg }),
    },
    pluginConfig,
    on(name: string, handler: RegisteredHook["handler"]) {
      hooks.push({ name, handler });
    },
    registerHook(name: string | string[], handler: RegisteredHook["handler"]) {
      const names = Array.isArray(name) ? name : [name];
      for (const n of names) hooks.push({ name: n, handler });
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  };
  return { api, hooks, tools, logs };
}

async function run(): Promise<void> {
  setup();
  console.log(`[smoke] root: ${ROOT}`);

  const ranker = new SkillsRanker({
    skillsDir: SKILLS_DIR,
    dbPath: DB_PATH,
    topN: 50,
  });

  // ---------------- T1 — index ----------------
  const indexed = ranker.index(SKILLS_DIR);
  console.log(`[T1] indexed=${indexed}`);
  assert(indexed === 50, `T1: indexed deveria ser 50, foi ${indexed}`);
  assert(ranker.totalCount() === 50, `T1: total_count deveria ser 50`);

  // ---------------- T2 — rank query relevante ----------------
  const q1 = "preciso criar uma landing page com copy de anuncio";
  const top1 = ranker.rank(q1, 5);
  console.log(
    `[T2] top5 ids:`,
    top1.map((s) => s.skill_id),
  );
  assert(
    top1.some((s) => s.skill_id === "landing-page-builder"),
    `T2: landing-page-builder devia estar no top 5`,
  );
  assert(
    !top1.every((s) => s.skill_id.startsWith("random-noise-")),
    `T2: top 5 nao pode ser SO random-noise`,
  );
  const nonNoise = top1.filter((s) => !s.skill_id.startsWith("random-noise-"));
  assert(nonNoise.length >= 1, `T2: top 5 deveria ter ao menos 1 skill relevante`);

  // ---------------- T3 — invocation tracking ----------------
  ranker.recordInvocation("landing-page-builder", "session-A", q1, "ok");
  ranker.recordInvocation("landing-page-builder", "session-A", q1, "ok");
  ranker.recordInvocation("landing-page-builder", "session-A", q1, "ok");

  const after = ranker.rank("landing", 1);
  console.log(`[T3] use_count=${after[0]?.use_count}, last_used=${after[0]?.last_used_at}`);
  assert(
    after[0]?.skill_id === "landing-page-builder",
    `T3: top1 deveria ser landing-page-builder`,
  );
  assert(after[0]?.use_count === 3, `T3: use_count deveria ser 3, foi ${after[0]?.use_count}`);
  assert(after[0]?.last_used_at != null, `T3: last_used_at deveria estar populado`);

  // ---------------- T4 — boost via uso faz skill subir ----------------
  const q4 = "marketing";
  for (let i = 0; i < 10; i++) {
    ranker.recordInvocation("landing-page-builder", "session-B", q4, "ok");
  }
  const t4 = ranker.rank(q4, 3);
  console.log(
    `[T4] marketing top3:`,
    t4.map((s) => `${s.skill_id}:${s.score.toFixed(3)}`),
  );
  assert(
    t4.some((s) => s.skill_id === "landing-page-builder"),
    `T4: landing-page-builder devia estar no top 3 apos boost de uso (top: ${t4
      .map((s) => s.skill_id)
      .join(",")})`,
  );

  // T5 + T8 use a fresh ranker built through the SDK harness so we exercise
  // the resolveConfig path. Close the manual ranker first to release the WAL
  // handle on the same DB file.
  ranker.close();

  // ---------------- T5 — tool skill_search via SDK harness ----------------
  const { api: api5, tools: tools5 } = makeMockApi({
    skillsDir: SKILLS_DIR,
    dbPath: DB_PATH,
    topN: 50,
  });
  registerSkillsRanker(api5);
  const skillSearchTool = tools5.find((t) => t.name === "skill_search");
  assert(skillSearchTool != null, `T5: skill_search tool deveria estar registrada`);
  assert(typeof skillSearchTool!.execute === "function", `T5: tool execute deveria ser funcao`);

  const searchOut = (await skillSearchTool!.execute("call-1", {
    query: "deploy vps",
    limit: 3,
  })) as {
    ok: boolean;
    skills: Array<{ skill_id: string; name: string; invocation_hint: string }>;
  };
  console.log(
    `[T5] search:`,
    searchOut.skills.map((s) => s.skill_id),
  );
  assert(searchOut.ok === true, `T5: search deveria retornar ok=true`);
  assert(
    searchOut.skills.some((s) => s.skill_id === "deploy-runner"),
    `T5: deploy-runner devia aparecer em search 'deploy vps'`,
  );
  assert(
    searchOut.skills[0].invocation_hint.includes("skill_invoke"),
    `T5: invocation_hint deve mencionar skill_invoke`,
  );

  // ---------------- T6 — fallback empty query ----------------
  // Use a fresh ranker (the SDK singleton in api5 already owns the DB handle)
  // so we keep T6 deterministic.
  const ranker6 = new SkillsRanker({
    skillsDir: SKILLS_DIR,
    dbPath: DB_PATH,
    topN: 50,
  });
  const fallback = ranker6.rank("", 5);
  console.log(`[T6] fallback len=${fallback.length}`);
  assert(fallback.length > 0, `T6: fallback nao pode ser vazio`);
  assert(
    fallback[0].skill_id === "landing-page-builder",
    `T6: fallback ordena por use_count, top devia ser landing-page-builder (foi ${fallback[0].skill_id})`,
  );

  // ---------------- T7 — snapshot ----------------
  const snap = ranker6.buildSnapshot(top1);
  console.log(`[T7] snapshot lines=${snap.split("\n").length}`);
  assert(snap.includes("Top 5"), `T7: snapshot devia conter 'Top 5'`);
  assert(snap.includes("de 50"), `T7: snapshot devia mencionar total 50`);
  assert(snap.includes("skill_search"), `T7: snapshot devia mencionar skill_search hint`);
  ranker6.close();

  // ---------------- T8 — SDK hooks: before_prompt_build + after_tool_call ----------------
  const {
    api: api8,
    hooks: hooks8,
    tools: tools8,
  } = makeMockApi({
    skillsDir: SKILLS_DIR,
    dbPath: DB_PATH,
    topN: 50,
  });
  registerSkillsRanker(api8);

  const hookNames = hooks8.map((h) => h.name).sort();
  console.log(`[T8] hooks registradas:`, hookNames);
  assert(
    hookNames.includes("before_prompt_build"),
    `T8: before_prompt_build deveria estar registrado`,
  );
  assert(hookNames.includes("after_tool_call"), `T8: after_tool_call deveria estar registrado`);
  assert(
    tools8.some((t) => t.name === "skill_search"),
    `T8: skill_search deveria estar registrado pela mesma chamada`,
  );

  const beforePromptHook = hooks8.find((h) => h.name === "before_prompt_build")!;
  const afterToolHook = hooks8.find((h) => h.name === "after_tool_call")!;

  // before_prompt_build deve retornar { appendSystemContext: <snapshot> }
  const promptResult = (await beforePromptHook.handler(
    { prompt: "preciso criar uma landing page", messages: [] },
    { sessionKey: "session-T8", agentId: "ace-tsia" },
  )) as { appendSystemContext?: string } | undefined;
  console.log(
    `[T8] before_prompt_build appendSystemContext len=${promptResult?.appendSystemContext?.length ?? 0}`,
  );
  assert(promptResult != null, `T8: before_prompt_build deveria retornar resultado nao-undefined`);
  assert(
    typeof promptResult!.appendSystemContext === "string" &&
      promptResult!.appendSystemContext!.length > 0,
    `T8: appendSystemContext deveria ser string nao-vazia`,
  );
  assert(
    promptResult!.appendSystemContext!.includes("skills relevantes"),
    `T8: appendSystemContext deveria conter cabecalho do snapshot`,
  );
  assert(
    promptResult!.appendSystemContext!.includes("landing-page-builder"),
    `T8: appendSystemContext deveria incluir landing-page-builder por relevancia FTS`,
  );

  // after_tool_call ignora tools que nao sao skill_invoke
  const ignored = await afterToolHook.handler(
    {
      toolName: "Bash",
      params: { command: "ls" },
      result: "ok",
      durationMs: 10,
    },
    { sessionKey: "session-T8" },
  );
  assert(
    ignored === undefined,
    `T8: after_tool_call em tool nao-skill_invoke deveria retornar undefined`,
  );

  // after_tool_call em skill_invoke bumpa use_count.
  // Lemos use_count direto do SQLite pra contornar o rank_cache (TTL 5min)
  // que reaproveita resultados de queries identicas dos cenarios anteriores.
  const usageBefore = rawUseCount(DB_PATH, "landing-page-builder");

  await afterToolHook.handler(
    {
      toolName: "skill_invoke",
      params: { skill_id: "landing-page-builder" },
      result: { ok: true },
      durationMs: 5,
    },
    { sessionKey: "session-T8" },
  );

  const usageAfter = rawUseCount(DB_PATH, "landing-page-builder");
  console.log(`[T8] use_count: before=${usageBefore} after=${usageAfter}`);
  assert(
    usageAfter === usageBefore + 1,
    `T8: after_tool_call(skill_invoke) deveria bumpar use_count de ${usageBefore} pra ${usageBefore + 1}, foi ${usageAfter}`,
  );

  // Sanity check: tool nao-skill_invoke (ex: Bash) NAO deve bumpar.
  const usagePreBash = rawUseCount(DB_PATH, "landing-page-builder");
  await afterToolHook.handler(
    {
      toolName: "Bash",
      params: { command: "echo hi" },
      result: "ok",
      durationMs: 1,
    },
    { sessionKey: "session-T8" },
  );
  const usagePostBash = rawUseCount(DB_PATH, "landing-page-builder");
  assert(
    usagePostBash === usagePreBash,
    `T8: tool nao-skill_invoke nao pode bumpar use_count (pre=${usagePreBash} post=${usagePostBash})`,
  );

  cleanup();
  console.log("[smoke] OK — todos os 8 testes passaram");
}

run().catch((err) => {
  cleanup();
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
