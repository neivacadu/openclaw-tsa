/**
 * tsa-skills-rank — SkillsRanker core (logic-preserved port from the flat
 * src/index.ts shipped in 0.1.0). The class, schema bootstrap, ranking
 * heuristics, FTS5 query building, invocation tracking, cache layer and
 * snapshot formatter are byte-equivalent to the legacy module — only the
 * file split changed (this is now the pure-logic module; SDK wiring lives
 * in src/plugin.ts).
 *
 * Banco SQLite local mantem TODAS as 1.424 skills (sem cortar).
 * Rank decide quais top N entram no system prompt;
 * restantes ficam invocaveis sob demanda via tool skill_search.
 *
 * V1: FTS5 + heuristicas (use_count recente, success_rate, category match)
 * V2 (roadmap): substitui FTS5 por pgvector quando Camada 4 subir.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import matter from "gray-matter";

// ============================================================================
// Types
// ============================================================================

export interface SkillRow {
  id: number;
  skill_id: string;
  skill_name: string;
  skill_path: string;
  description: string | null;
  keywords: string | null;
  category: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  use_count: number;
  success_rate: number;
}

export interface RankedSkill extends SkillRow {
  score: number;
  fts_rank: number;
  recency_score: number;
  category_match: number;
}

export interface RankerConfig {
  topN: number;
  fts5Weight: number;
  useRecencyWeight: number;
  successRateWeight: number;
  categoryMatchWeight: number;
  skillsDir: string;
  dbPath: string;
  recencyWindowDays: number;
  snapshotKey: string;
  metricsPushgateway?: string;
}

export const DEFAULT_CONFIG: RankerConfig = {
  topN: 50,
  fts5Weight: 0.4,
  useRecencyWeight: 0.3,
  successRateWeight: 0.2,
  categoryMatchWeight: 0.1,
  skillsDir: "/home/ace-tsia/.openclaw/workspace/skills",
  dbPath: "/home/ace-tsia/.openclaw/data/skills.sqlite",
  recencyWindowDays: 30,
  snapshotKey: "skillsSnapshot",
};

// ============================================================================
// Metrics (Prometheus pushgateway opcional)
// ============================================================================

const metrics = {
  rankQueries: { ok: 0, error: 0, empty: 0 },
  indexed: 0,
  invocations: new Map<string, number>(),
};

export async function pushMetrics(cfg: RankerConfig): Promise<void> {
  if (!cfg.metricsPushgateway) return;
  const lines: string[] = [
    `# TYPE tsa_skills_rank_query_total counter`,
    `tsa_skills_rank_query_total{result="ok"} ${metrics.rankQueries.ok}`,
    `tsa_skills_rank_query_total{result="error"} ${metrics.rankQueries.error}`,
    `tsa_skills_rank_query_total{result="empty"} ${metrics.rankQueries.empty}`,
    `# TYPE tsa_skills_indexed_total gauge`,
    `tsa_skills_indexed_total ${metrics.indexed}`,
    `# TYPE tsa_skill_invocations_total counter`,
  ];
  for (const [skillId, count] of metrics.invocations.entries()) {
    lines.push(`tsa_skill_invocations_total{skill_id="${skillId}"} ${count}`);
  }
  try {
    await fetch(`${cfg.metricsPushgateway}/metrics/job/tsa_skills_rank`, {
      method: "POST",
      body: lines.join("\n") + "\n",
      headers: { "Content-Type": "text/plain" },
    });
  } catch {
    /* best-effort */
  }
}

// ============================================================================
// Core class
// ============================================================================

export class SkillsRanker {
  private db: Database.Database;
  private cfg: RankerConfig;

  constructor(cfg: Partial<RankerConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.ensureDir(dirname(this.cfg.dbPath));
    this.db = new Database(this.cfg.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.bootstrap();
  }

  /** Read-only access to resolved config (used by SDK wiring + tests). */
  get config(): Readonly<RankerConfig> {
    return this.cfg;
  }

  private ensureDir(p: string): void {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  private bootstrap(): void {
    // Resolve sql/schema.sql relative to compiled module path. Under
    // tsc rootDir=".", this file lives at dist/src/skills-ranker.js,
    // so ../../sql/schema.sql lands on plugin_root/sql/schema.sql.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "sql", "schema.sql"),
      join(here, "..", "sql", "schema.sql"),
    ];
    let schema: string | null = null;
    for (const p of candidates) {
      if (existsSync(p)) {
        schema = readFileSync(p, "utf-8");
        break;
      }
    }
    if (!schema) {
      // fallback inline (caso plugin packed sem sql/)
      schema = INLINE_SCHEMA;
    }
    this.db.exec(schema);
  }

  // --------------------------------------------------------------------------
  // INDEX
  // --------------------------------------------------------------------------

  /**
   * Walk skillsDir, parse SKILL.md frontmatter, upsert no banco.
   * Retorna count indexado.
   */
  index(skillsDir: string = this.cfg.skillsDir): number {
    if (!existsSync(skillsDir)) {
      throw new Error(`skillsDir nao existe: ${skillsDir}`);
    }

    const found = this.walkSkills(skillsDir);
    const seenIds = new Set<string>();

    const upsert = this.db.prepare(`
      INSERT INTO skills (skill_id, skill_name, skill_path, description, keywords, category, updated_at)
      VALUES (@skill_id, @skill_name, @skill_path, @description, @keywords, @category, CURRENT_TIMESTAMP)
      ON CONFLICT(skill_id) DO UPDATE SET
        skill_name = excluded.skill_name,
        skill_path = excluded.skill_path,
        description = excluded.description,
        keywords = excluded.keywords,
        category = excluded.category,
        updated_at = CURRENT_TIMESTAMP
    `);

    const tx = this.db.transaction((items: ParsedSkill[]) => {
      for (const it of items) {
        upsert.run(it);
        seenIds.add(it.skill_id);
      }
    });
    tx(found);

    // Remove skills deletadas do filesystem
    if (seenIds.size > 0) {
      const placeholders = Array.from(seenIds)
        .map(() => "?")
        .join(",");
      const stmt = this.db.prepare(`DELETE FROM skills WHERE skill_id NOT IN (${placeholders})`);
      stmt.run(...Array.from(seenIds));
    }

    metrics.indexed = found.length;
    return found.length;
  }

  private walkSkills(root: string): ParsedSkill[] {
    const out: ParsedSkill[] = [];
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(full);
        } else if (e === "SKILL.md") {
          const parsed = this.parseSkillFile(full, root);
          if (parsed) out.push(parsed);
        }
      }
    }
    return out;
  }

  private parseSkillFile(path: string, root: string): ParsedSkill | null {
    try {
      const raw = readFileSync(path, "utf-8");
      const fm = matter(raw);
      const data = (fm.data ?? {}) as Record<string, unknown>;
      const skill_name = String(data.name ?? data.title ?? "").trim();
      if (!skill_name) return null;
      const skill_id = String(data.id ?? this.deriveId(path, root)).trim();
      const description = String(data.description ?? "").trim() || null;
      const keywords = Array.isArray(data.keywords)
        ? (data.keywords as string[]).join(",")
        : typeof data.keywords === "string"
          ? data.keywords
          : null;
      const category = (data.category as string | undefined) ?? this.deriveCategory(path, root);
      return {
        skill_id,
        skill_name,
        skill_path: path,
        description,
        keywords,
        category,
      };
    } catch {
      return null;
    }
  }

  private deriveId(path: string, root: string): string {
    const rel = path
      .replace(root, "")
      .replace(/^\/+/, "")
      .replace(/\/SKILL\.md$/, "");
    return rel.replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  private deriveCategory(path: string, root: string): string {
    const rel = path.replace(root, "").replace(/^\/+/, "");
    const first = rel.split("/")[0];
    return first || "uncategorized";
  }

  // --------------------------------------------------------------------------
  // RANK
  // --------------------------------------------------------------------------

  /**
   * Dada query do user, retorna top N skills rankeadas.
   * Score = fts*0.4 + recency*0.3 + success*0.2 + category*0.1
   */
  rank(query: string, limit: number = this.cfg.topN): RankedSkill[] {
    const cleaned = (query ?? "").trim();
    if (!cleaned) {
      metrics.rankQueries.empty++;
      return this.fallbackByUsage(limit);
    }

    try {
      const cached = this.checkCache(cleaned, limit);
      if (cached) {
        metrics.rankQueries.ok++;
        return cached;
      }

      const ftsQuery = this.buildFtsQuery(cleaned);
      const candidates = this.db
        .prepare(
          `
          SELECT
            s.*,
            bm25(skills_fts) AS bm25_raw
          FROM skills_fts
          JOIN skills s ON s.id = skills_fts.rowid
          WHERE skills_fts MATCH ?
          ORDER BY bm25(skills_fts)
          LIMIT 200
        `,
        )
        .all(ftsQuery) as (SkillRow & { bm25_raw: number })[];

      // Se FTS5 nao bater nada, fallback usage
      if (candidates.length === 0) {
        metrics.rankQueries.empty++;
        return this.fallbackByUsage(limit);
      }

      const queryCategories = this.inferCategories(cleaned);
      const now = Date.now();
      const windowMs = this.cfg.recencyWindowDays * 86400 * 1000;

      const ranked: RankedSkill[] = candidates.map((c) => {
        // bm25 menor = melhor; normalizar pra [0,1] onde 1 = melhor
        const fts_rank = 1 / (1 + Math.max(0, c.bm25_raw));

        const lastUsed = c.last_used_at ? new Date(c.last_used_at).getTime() : 0;
        const ageMs = lastUsed ? now - lastUsed : windowMs * 10;
        const recency_score = lastUsed ? Math.max(0, 1 - ageMs / windowMs) : 0;
        const usage_boost = Math.min(1, Math.log10(c.use_count + 1) / 2); // 1 hit ~ 0.15, 100 hits ~ 1
        const recency_combined = (recency_score + usage_boost) / 2;

        const success = Math.max(0, Math.min(1, c.success_rate ?? 1));

        const category_match = queryCategories.includes(c.category ?? "") ? 1 : 0;

        const score =
          fts_rank * this.cfg.fts5Weight +
          recency_combined * this.cfg.useRecencyWeight +
          success * this.cfg.successRateWeight +
          category_match * this.cfg.categoryMatchWeight;

        return {
          ...c,
          score,
          fts_rank,
          recency_score: recency_combined,
          category_match,
        };
      });

      ranked.sort((a, b) => b.score - a.score);
      const top = ranked.slice(0, limit);

      this.writeCache(cleaned, limit, top);
      metrics.rankQueries.ok++;
      return top;
    } catch {
      metrics.rankQueries.error++;
      // graceful degradation: nunca falhar o prompt build
      return this.fallbackByUsage(limit);
    }
  }

  /**
   * Quando FTS5 nao bate nada, devolve mais usadas (mantem ace funcional).
   */
  private fallbackByUsage(limit: number): RankedSkill[] {
    const rows = this.db
      .prepare(`SELECT * FROM skills ORDER BY use_count DESC, last_used_at DESC LIMIT ?`)
      .all(limit) as SkillRow[];
    return rows.map((r) => ({
      ...r,
      score: 0,
      fts_rank: 0,
      recency_score: 0,
      category_match: 0,
    }));
  }

  /**
   * Tokeniza query e monta query FTS5 segura.
   * Estrategia: tokens >= 3 chars, com prefix match (token*).
   */
  private buildFtsQuery(query: string): string {
    const tokens = query
      .toLowerCase()
      .replace(/[^\w\sÀ-ÿ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
      .slice(0, 8); // cap pra nao explodir
    if (tokens.length === 0) {
      return query.replace(/['"]/g, "").slice(0, 80);
    }
    return tokens.map((t) => `${t}*`).join(" OR ");
  }

  /**
   * Heuristica simples pra inferir categoria da query.
   * V2 substitui por embedding similarity.
   */
  private inferCategories(query: string): string[] {
    const q = query.toLowerCase();
    const cats: string[] = [];
    const map: Record<string, string[]> = {
      marketing: ["landing", "anuncio", "ads", "copy", "campanha", "marketing"],
      dev: ["codigo", "code", "deploy", "bug", "fix", "refactor", "test"],
      data: ["sql", "query", "dashboard", "metric", "analise", "data"],
      content: ["post", "artigo", "video", "thumbnail", "conteudo"],
      ops: ["server", "deploy", "infra", "monitor", "alert"],
    };
    for (const [cat, keywords] of Object.entries(map)) {
      if (keywords.some((k) => q.includes(k))) cats.push(cat);
    }
    return cats;
  }

  // --------------------------------------------------------------------------
  // SEARCH (tool exposed to ace)
  // --------------------------------------------------------------------------

  search(query: string, limit: number = 10): RankedSkill[] {
    return this.rank(query, limit);
  }

  // --------------------------------------------------------------------------
  // INVOCATION TRACKING
  // --------------------------------------------------------------------------

  recordInvocation(
    skillId: string,
    sessionId: string | null,
    query: string | null,
    result: "ok" | "error" | "timeout" | "partial" = "ok",
  ): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO skill_invocations (skill_id, session_id, query, result) VALUES (?, ?, ?, ?)`,
        )
        .run(skillId, sessionId, query, result);

      this.db
        .prepare(
          `UPDATE skills
           SET last_used_at = CURRENT_TIMESTAMP,
               use_count = use_count + 1,
               success_rate = CASE
                 WHEN ? = 'ok' THEN MIN(1.0, success_rate * 0.95 + 0.05)
                 WHEN ? = 'error' THEN MAX(0.0, success_rate * 0.95)
                 ELSE success_rate
               END
           WHERE skill_id = ?`,
        )
        .run(result, result, skillId);
    });
    tx();

    metrics.invocations.set(skillId, (metrics.invocations.get(skillId) ?? 0) + 1);
  }

  // --------------------------------------------------------------------------
  // CACHE
  // --------------------------------------------------------------------------

  private cacheKey(query: string, limit: number): string {
    return createHash("sha1").update(`${query}|${limit}`).digest("hex");
  }

  private checkCache(query: string, limit: number): RankedSkill[] | null {
    const key = this.cacheKey(query, limit);
    const row = this.db
      .prepare(
        `SELECT result_json, created_at FROM rank_cache
         WHERE query_hash = ? AND created_at > datetime('now', '-5 minutes')`,
      )
      .get(key) as { result_json: string; created_at: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.result_json) as RankedSkill[];
    } catch {
      return null;
    }
  }

  private writeCache(query: string, limit: number, result: RankedSkill[]): void {
    const key = this.cacheKey(query, limit);
    this.db
      .prepare(
        `INSERT INTO rank_cache (query_hash, result_json) VALUES (?, ?)
         ON CONFLICT(query_hash) DO UPDATE SET result_json = excluded.result_json, created_at = CURRENT_TIMESTAMP`,
      )
      .run(key, JSON.stringify(result));
  }

  // --------------------------------------------------------------------------
  // SNAPSHOT pro system prompt
  // --------------------------------------------------------------------------

  buildSnapshot(skills: RankedSkill[]): string {
    const lines = [
      `## Top ${skills.length} skills relevantes (de ${this.totalCount()} no banco)`,
      `Skills fora do top sao invocaveis via tool \`skill_search(query)\`.`,
      "",
    ];
    for (const s of skills) {
      const desc = (s.description ?? "(sem descricao)").replace(/\s+/g, " ").trim();
      lines.push(`- **${s.skill_name}** (\`${s.skill_id}\`, cat=${s.category ?? "n/a"}) — ${desc}`);
    }
    return lines.join("\n");
  }

  totalCount(): number {
    const r = this.db.prepare(`SELECT COUNT(*) as c FROM skills`).get() as { c: number };
    return r.c;
  }

  close(): void {
    this.db.close();
  }
}

// ============================================================================
// Internals
// ============================================================================

interface ParsedSkill {
  skill_id: string;
  skill_name: string;
  skill_path: string;
  description: string | null;
  keywords: string | null;
  category: string;
}

const INLINE_SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT UNIQUE NOT NULL,
  skill_name TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  description TEXT,
  keywords TEXT,
  category TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  use_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 1.0,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_last_used ON skills(last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_use_count ON skills(use_count DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  skill_id, skill_name, description, keywords,
  content='skills', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, skill_id, skill_name, description, keywords)
  VALUES (new.id, new.skill_id, new.skill_name, new.description, new.keywords);
END;
CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, skill_id, skill_name, description, keywords)
  VALUES ('delete', old.id, old.skill_id, old.skill_name, old.description, old.keywords);
END;
CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, skill_id, skill_name, description, keywords)
  VALUES ('delete', old.id, old.skill_id, old.skill_name, old.description, old.keywords);
  INSERT INTO skills_fts(rowid, skill_id, skill_name, description, keywords)
  VALUES (new.id, new.skill_id, new.skill_name, new.description, new.keywords);
END;
CREATE TABLE IF NOT EXISTS skill_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  session_id TEXT,
  query TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_invocations_skill_id ON skill_invocations(skill_id);
CREATE TABLE IF NOT EXISTS rank_cache (
  query_hash TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

export default SkillsRanker;
