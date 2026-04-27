import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolves the workspace path equivalent to what the bash hook reads:
 * `~/.openclaw/workspace/CLAUDE.md`. Falls back to the global TSA constitution
 * path if the workspace copy is missing.
 */
const CANDIDATE_PATHS = [
  path.join(os.homedir(), ".openclaw", "workspace", "CLAUDE.md"),
  "/etc/aceupgrade/CONSTITUTION.md",
];

const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "constitution.log");

type CacheEntry = {
  path: string;
  mtimeMs: number;
  content: string;
};

let cache: CacheEntry | null = null;

/**
 * Lazily loads the Constitution text. Re-reads if the file mtime changed
 * (cheap stat). Returns "" if no source is found — checks then run on rules
 * that don't depend on the document (4, 7, 11) and only rule 14 degrades to
 * a no-op without source text.
 */
export function loadConstitution(): string {
  for (const candidate of CANDIDATE_PATHS) {
    try {
      const stat = fs.statSync(candidate);
      if (cache && cache.path === candidate && cache.mtimeMs === stat.mtimeMs) {
        return cache.content;
      }
      const content = fs.readFileSync(candidate, "utf8");
      cache = { path: candidate, mtimeMs: stat.mtimeMs, content };
      return content;
    } catch {
      continue;
    }
  }
  return cache?.content ?? "";
}

/**
 * Append a log line in the exact format produced by constitution.sh so existing
 * grep/awk pipelines keep working: `[<iso-ts>] action=<a> <message>`.
 *
 * Best-effort: silently drops on filesystem errors (e.g. log dir missing) —
 * we never want logging IO to crash a tool call.
 */
export function appendLog(action: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] action=${action} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // intentional: log failures must not block tool execution
  }
}
