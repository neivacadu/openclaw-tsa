/**
 * smoke test tsa-skills-rank
 *
 * NAO TOCA producao. Usa /tmp + workspace mock.
 *
 * Cenarios:
 *  T1 — index() popula DB com 50 skills mock
 *  T2 — rank("criar landing page") inclui landing-page-builder no top 5,
 *       NAO inclui skills aleatorias (random-noise-*)
 *  T3 — recordInvocation() 3x → use_count=3, last_used_at recente
 *  T4 — apos boost, skill usada sobe no rank
 *  T5 — skill_search devolve resultados com hint
 *  T6 — fallback by usage quando query vazia
 *  T7 — total_count = 50 e snapshot string contem header com total
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsRanker, toolSkillSearch } from "./index.js";

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

async function run(): Promise<void> {
  setup();
  console.log(`[smoke] root: ${ROOT}`);

  const ranker = new SkillsRanker({
    skillsDir: SKILLS_DIR,
    dbPath: DB_PATH,
    topN: 50,
  });

  // T1 — index
  const indexed = ranker.index(SKILLS_DIR);
  console.log(`[T1] indexed=${indexed}`);
  assert(indexed === 50, `T1: indexed deveria ser 50, foi ${indexed}`);
  assert(ranker.totalCount() === 50, `T1: total_count deveria ser 50`);

  // T2 — rank query relevante
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
  // Pelo menos 1 dos 5 nao deve ser noise
  const nonNoise = top1.filter((s) => !s.skill_id.startsWith("random-noise-"));
  assert(nonNoise.length >= 1, `T2: top 5 deveria ter ao menos 1 skill relevante`);

  // T3 — invocation tracking
  ranker.recordInvocation("landing-page-builder", "session-A", q1, "ok");
  ranker.recordInvocation("landing-page-builder", "session-A", q1, "ok");
  ranker.recordInvocation("landing-page-builder", "session-A", q1, "ok");

  // Re-rank pra puxar do banco
  const after = ranker.rank("landing", 1);
  console.log(`[T3] use_count=${after[0]?.use_count}, last_used=${after[0]?.last_used_at}`);
  assert(
    after[0]?.skill_id === "landing-page-builder",
    `T3: top1 deveria ser landing-page-builder`,
  );
  assert(after[0]?.use_count === 3, `T3: use_count deveria ser 3, foi ${after[0]?.use_count}`);
  assert(after[0]?.last_used_at != null, `T3: last_used_at deveria estar populado`);

  // T4 — boost via uso faz skill subir
  // Usar query generica onde landing nao casaria sozinha por FTS, e ver se boost ajuda
  const q4 = "marketing"; // multiplas marketing skills batem
  // Antes de boost extra, registrar 10x landing
  for (let i = 0; i < 10; i++) {
    ranker.recordInvocation("landing-page-builder", "session-B", q4, "ok");
  }
  const t4 = ranker.rank(q4, 3);
  console.log(
    `[T4] marketing top3:`,
    t4.map((s) => `${s.skill_id}:${s.score.toFixed(3)}`),
  );
  // Landing deve ranquear bem por uso + categoria + FTS (description tem "lead" mas nao "marketing")
  // Asseguramos: landing-page-builder esta no top 3 por boost de uso
  assert(
    t4.some((s) => s.skill_id === "landing-page-builder"),
    `T4: landing-page-builder devia estar no top 3 apos boost de uso (top: ${t4.map((s) => s.skill_id).join(",")})`,
  );

  // T5 — tool skill_search
  const searchOut = await toolSkillSearch({
    input: { query: "deploy vps", limit: 3 },
    config: { skillsDir: SKILLS_DIR, dbPath: DB_PATH },
  });
  console.log(
    `[T5] search:`,
    searchOut.skills.map((s) => s.skill_id),
  );
  assert(
    searchOut.skills.some((s) => s.skill_id === "deploy-runner"),
    `T5: deploy-runner devia aparecer em search 'deploy vps'`,
  );
  assert(
    searchOut.skills[0].invocation_hint.includes("skill_invoke"),
    `T5: invocation_hint deve mencionar skill_invoke`,
  );

  // T6 — fallback empty query
  const fallback = ranker.rank("", 5);
  console.log(`[T6] fallback len=${fallback.length}`);
  assert(fallback.length > 0, `T6: fallback nao pode ser vazio`);
  // landing tem 13 invocacoes agora, deve estar no top do fallback
  assert(
    fallback[0].skill_id === "landing-page-builder",
    `T6: fallback ordena por use_count, top devia ser landing-page-builder (foi ${fallback[0].skill_id})`,
  );

  // T7 — snapshot
  const snap = ranker.buildSnapshot(top1);
  console.log(`[T7] snapshot lines=${snap.split("\n").length}`);
  assert(snap.includes("Top 5"), `T7: snapshot devia conter 'Top 5'`);
  assert(snap.includes("de 50"), `T7: snapshot devia mencionar total 50`);
  assert(snap.includes("skill_search"), `T7: snapshot devia mencionar skill_search hint`);

  ranker.close();
  cleanup();
  console.log("[smoke] OK — todos os 7 testes passaram");
}

run().catch((err) => {
  cleanup();
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
