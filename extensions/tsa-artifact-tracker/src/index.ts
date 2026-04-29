/**
 * tsa-artifact-tracker
 *
 * Auto-tracks artifacts (HTML, PDF, MD, images, etc) produced by Write/Edit/Bash
 * via the after_tool_call hook. Stores metadata + FTS5 index in SQLite, exposes
 * tools (artifacts_search / artifacts_recent / artifacts_get_by_path /
 * artifacts_update_status) for the Ace to retrieve them in later sessions.
 *
 * Designed to power the "remember what you built" gap — see INTEGRATION-WITH-P0A.md.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArtifactKind =
  | "html"
  | "pdf"
  | "doc"
  | "md"
  | "image"
  | "video"
  | "audio"
  | "data"
  | "code"
  | "other";

export type ArtifactStatus = "active" | "archived" | "deleted";

export interface Artifact {
  id: number;
  kind: ArtifactKind;
  path: string;
  filename: string;
  size_bytes: number | null;
  mime_type: string | null;
  public_url: string | null;
  created_by_agent: string | null;
  created_in_session: string | null;
  prompt_summary: string | null;
  created_at: string;
  updated_at: string;
  status: ArtifactStatus;
  tags: string | null;
  content_hash: string | null;
}

export interface TrackerConfig {
  dbPath: string;
  publicUrlMappings: Record<string, string>;
  trackedTools: string[];
  minSize: number;
  ignorePaths: string[];
}

export interface SessionContext {
  agent?: string;
  sessionId?: string;
  promptSummary?: string;
}

// ---------------------------------------------------------------------------
// Defaults + lightweight metric stubs
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: TrackerConfig = {
  dbPath: "/home/ace-tsia/.openclaw/data/artifacts.sqlite",
  publicUrlMappings: { "/var/www/ace/": "https://ace.caduneiva.com/" },
  trackedTools: ["Write", "Edit", "Bash"],
  minSize: 100,
  ignorePaths: ["/tmp/", ".git/", "node_modules/", ".cache/", "/.openclaw/cache/"],
};

const metrics = {
  tracked: new Map<string, number>(),
  searches: 0,
  inc(kind: ArtifactKind) {
    this.tracked.set(kind, (this.tracked.get(kind) ?? 0) + 1);
  },
  incSearch() {
    this.searches += 1;
  },
};

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

const KIND_BY_EXT: Record<string, ArtifactKind> = {
  ".html": "html",
  ".htm": "html",
  ".pdf": "pdf",
  ".doc": "doc",
  ".docx": "doc",
  ".odt": "doc",
  ".rtf": "doc",
  ".md": "md",
  ".markdown": "md",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".bmp": "image",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".mkv": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".flac": "audio",
  ".ogg": "audio",
  ".csv": "data",
  ".tsv": "data",
  ".json": "data",
  ".parquet": "data",
  ".xlsx": "data",
  ".sqlite": "data",
  ".db": "data",
  ".ts": "code",
  ".tsx": "code",
  ".js": "code",
  ".jsx": "code",
  ".py": "code",
  ".go": "code",
  ".rs": "code",
  ".sh": "code",
  ".java": "code",
  ".kt": "code",
  ".rb": "code",
  ".php": "code",
  ".c": "code",
  ".cpp": "code",
  ".h": "code",
  ".cs": "code",
};

const MIME_BY_KIND: Record<ArtifactKind, string> = {
  html: "text/html",
  pdf: "application/pdf",
  doc: "application/msword",
  md: "text/markdown",
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
  data: "application/octet-stream",
  code: "text/plain",
  other: "application/octet-stream",
};

export function inferKind(p: string): ArtifactKind {
  return KIND_BY_EXT[path.extname(p).toLowerCase()] ?? "other";
}

export function inferPublicUrl(p: string, mappings: Record<string, string>): string | null {
  for (const [prefix, base] of Object.entries(mappings)) {
    if (p.startsWith(prefix)) {
      const rel = p.slice(prefix.length);
      return base.replace(/\/+$/, "/") + rel.replace(/^\/+/, "");
    }
  }
  return null;
}

function hashFile(p: string): string | null {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool result parsing — extract created/written paths from heterogeneous shapes
// ---------------------------------------------------------------------------

const PATH_HINT_RE =
  /(?:wrote|created|saved|published|generated|appended|updated)\s+(?:to\s+|file\s+)?(?:`|"|')?(\/[^\s`"'<>]+)(?:`|"|')?/gi;
const BARE_PATH_RE = /(?:^|\s)(\/[A-Za-z0-9_./-]{4,})/g;

export function parseArtifactsFromResult(
  toolName: string,
  toolArgs: Record<string, unknown>,
  toolResult: unknown,
): string[] {
  const paths = new Set<string>();

  // Write/Edit normally carry the path in args.
  for (const k of ["file_path", "path", "filename", "output", "destination"]) {
    const v = toolArgs?.[k];
    if (typeof v === "string" && v.startsWith("/")) paths.add(v);
  }

  // Tool result text: regex-scrape "wrote /x", "created /y", or bare /paths.
  const text =
    typeof toolResult === "string"
      ? toolResult
      : toolResult && typeof toolResult === "object"
        ? JSON.stringify(toolResult)
        : "";

  let m: RegExpExecArray | null;
  while ((m = PATH_HINT_RE.exec(text)) !== null) paths.add(m[1]);
  PATH_HINT_RE.lastIndex = 0;

  // Bash: also try args.command for redirection targets `> /path` and `tee /path`.
  if (toolName === "Bash") {
    const cmd = String(toolArgs?.command ?? "");
    const redirect = /(?:>|>>|tee\s+(?:-a\s+)?)\s*(\/[^\s|;&]+)/g;
    while ((m = redirect.exec(cmd)) !== null) paths.add(m[1]);
  }

  // Last-resort bare-path scan only if we still found nothing.
  if (paths.size === 0 && text) {
    while ((m = BARE_PATH_RE.exec(text)) !== null) {
      const p = m[1];
      if (path.extname(p)) paths.add(p);
    }
    BARE_PATH_RE.lastIndex = 0;
  }

  return [...paths];
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class ArtifactTracker {
  private db: Database.Database;
  private cfg: TrackerConfig;

  constructor(cfg: Partial<TrackerConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    fs.mkdirSync(path.dirname(this.cfg.dbPath), { recursive: true });
    this.db = new Database(this.cfg.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.applySchema();
  }

  private applySchema(): void {
    const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
    if (fs.existsSync(schemaPath)) {
      this.db.exec(fs.readFileSync(schemaPath, "utf8"));
      return;
    }
    // Fallback inline schema for cases where sql/ wasn't shipped (rare).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        path TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL,
        size_bytes INTEGER, mime_type TEXT, public_url TEXT,
        created_by_agent TEXT, created_in_session TEXT, prompt_summary TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'active', tags TEXT, content_hash TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts
        USING fts5(path, filename, prompt_summary, tags,
                   content='artifacts', content_rowid='id');
    `);
  }

  private isIgnored(p: string): boolean {
    return this.cfg.ignorePaths.some((ig) => p.includes(ig));
  }

  /** Hook entrypoint: extract artifacts from a tool result and persist them. */
  track(
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolResult: unknown,
    sessionContext: SessionContext = {},
  ): Artifact[] {
    if (!this.cfg.trackedTools.includes(toolName)) return [];
    const candidates = parseArtifactsFromResult(toolName, toolArgs, toolResult);
    const stored: Artifact[] = [];

    for (const p of candidates) {
      if (this.isIgnored(p)) continue;
      let size: number | null = null;
      try {
        size = fs.statSync(p).size;
      } catch {
        continue; /* ghost path */
      }
      if (size != null && size < this.cfg.minSize) continue;

      const kind = inferKind(p);
      const filename = path.basename(p);
      const publicUrl = inferPublicUrl(p, this.cfg.publicUrlMappings);
      const contentHash = hashFile(p);
      const tags = JSON.stringify({ ext: path.extname(p), tool: toolName });

      const stmt = this.db.prepare(`
        INSERT INTO artifacts
          (kind, path, filename, size_bytes, mime_type, public_url,
           created_by_agent, created_in_session, prompt_summary, tags, content_hash)
        VALUES (@kind, @path, @filename, @size, @mime, @url,
                @agent, @session, @summary, @tags, @hash)
        ON CONFLICT(path) DO UPDATE SET
          size_bytes  = excluded.size_bytes,
          content_hash= excluded.content_hash,
          updated_at  = CURRENT_TIMESTAMP,
          status      = 'active'
      `);
      stmt.run({
        kind,
        path: p,
        filename,
        size,
        mime: MIME_BY_KIND[kind],
        url: publicUrl,
        agent: sessionContext.agent ?? null,
        session: sessionContext.sessionId ?? null,
        summary: sessionContext.promptSummary ?? null,
        tags,
        hash: contentHash,
      });

      const row = this.getByPath(p);
      if (row) {
        stored.push(row);
        metrics.inc(kind);
      }
    }
    return stored;
  }

  searchByQuery(query: string, kind?: string, limit = 10): Artifact[] {
    metrics.incSearch();
    const safe = query.replace(/"/g, '""');
    const params: unknown[] = [`"${safe}"`];
    let sql = `
      SELECT a.* FROM artifacts a
      JOIN artifacts_fts f ON f.rowid = a.id
      WHERE artifacts_fts MATCH ? AND a.status = 'active'
    `;
    if (kind) {
      sql += " AND a.kind = ?";
      params.push(kind);
    }
    sql += " ORDER BY a.created_at DESC LIMIT ?";
    params.push(limit);
    return this.db.prepare(sql).all(...params) as Artifact[];
  }

  recent(hoursBack = 24, limit = 20): Artifact[] {
    return this.db
      .prepare(`
      SELECT * FROM artifacts
      WHERE status = 'active'
        AND created_at >= datetime('now', ?)
      ORDER BY created_at DESC LIMIT ?
    `)
      .all(`-${hoursBack} hours`, limit) as Artifact[];
  }

  getByPath(p: string): Artifact | null {
    return (this.db.prepare("SELECT * FROM artifacts WHERE path = ?").get(p) as Artifact) ?? null;
  }

  updateStatus(p: string, status: ArtifactStatus): boolean {
    const r = this.db
      .prepare("UPDATE artifacts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?")
      .run(status, p);
    return r.changes > 0;
  }

  statusCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM artifacts GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  metrics() {
    return {
      tsa_artifacts_tracked_total: Object.fromEntries(metrics.tracked),
      tsa_artifacts_searches_total: metrics.searches,
      tsa_artifacts_total: this.statusCounts(),
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Singleton + manifest entrypoints (loaded by OpenClaw)
// ---------------------------------------------------------------------------

let _singleton: ArtifactTracker | null = null;
function tracker(cfg?: Partial<TrackerConfig>): ArtifactTracker {
  if (!_singleton) _singleton = new ArtifactTracker(cfg);
  return _singleton;
}

export async function onAfterToolCall(ctx: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult: unknown;
  agent?: string;
  sessionId?: string;
  promptSummary?: string;
  config?: Partial<TrackerConfig>;
}): Promise<void> {
  try {
    tracker(ctx.config).track(ctx.toolName, ctx.toolArgs, ctx.toolResult, {
      agent: ctx.agent,
      sessionId: ctx.sessionId,
      promptSummary: ctx.promptSummary,
    });
  } catch (e) {
    // Hooks must never throw into the tool path; log and move on.
    console.error("[tsa-artifact-tracker] track failed:", (e as Error).message);
  }
}

export async function toolSearch(args: { query: string; kind?: string; limit?: number }) {
  return tracker().searchByQuery(args.query, args.kind, args.limit ?? 10);
}
export async function toolRecent(args: { hours_back?: number; limit?: number }) {
  return tracker().recent(args.hours_back ?? 24, args.limit ?? 20);
}
export async function toolGetByPath(args: { path: string }) {
  return tracker().getByPath(args.path);
}
export async function toolUpdateStatus(args: { path: string; status: ArtifactStatus }) {
  const ok = tracker().updateStatus(args.path, args.status);
  return { ok };
}
