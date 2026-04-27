import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "bash-exec.log");

/** SLO breach threshold (matches log-bash-exec.sh v2.3): 30 seconds. */
const SLO_THRESHOLD_MS = 30_000;

/** Bash-style tools we want to log. Case-insensitive. */
const BASH_LIKE_TOOLS = new Set(["bash", "shell", "execute", "exec", "run-shell"]);

function isBashLikeTool(toolName: string): boolean {
  if (!toolName) return false;
  return BASH_LIKE_TOOLS.has(toolName.toLowerCase());
}

function extractCommandString(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  for (const key of ["command", "cmd", "script", "input"]) {
    const v = params[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // Fallback: serialize whole params truncated.
  try {
    return JSON.stringify(params).slice(0, 200);
  } catch {
    return String(params).slice(0, 200);
  }
}

/**
 * Best-effort extract of stdout from the after_tool_call event.result, which
 * may be a string, an array of content blocks, or some provider-specific
 * shape. We never throw — fallback is "" and the log line just omits the
 * result_head row, matching the bash hook's behavior when $RESULT is empty.
 */
function extractResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (typeof r.stdout === "string") return r.stdout;
  if (typeof r.output === "string") return r.output;
  if (typeof r.text === "string") return r.text;
  if (Array.isArray(r.content)) {
    return r.content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * Best-effort extract of exit code from result. Bash tools usually expose it
 * directly; fall back to "?" to mirror the bash hook default.
 */
function extractExitCode(result: unknown, error: string | undefined): string {
  if (error) return "1";
  if (!result || typeof result !== "object") return "?";
  const r = result as Record<string, unknown>;
  if (typeof r.exitCode === "number") return String(r.exitCode);
  if (typeof r.exit_code === "number") return String(r.exit_code);
  if (typeof r.code === "number") return String(r.code);
  return "0";
}

function appendLog(lines: string[]): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, lines.join("") + "");
  } catch {
    // never break tool execution because of logging IO
  }
}

/**
 * Registers the TSA log-bash-exec after_tool_call hook.
 *
 * Reads durationMs from the event itself (preferred over the legacy
 * OPENCLAW_TOOL_DURATION_MS env var the bash hook used). Logs in two lines
 * matching the bash hook format:
 *
 *   [<ts>] exit=<code> duration_ms=<n>[ SLO_BREACH=true] cmd=<truncated>
 *   [<ts>] result_head: <single-line, ≤800 chars>
 *
 * The hook signature is `(event, ctx) => Promise<void> | void` — we always
 * return undefined / void. This is observability, never blocking.
 */
export function registerLogBashExecPlugin(api: OpenClawPluginApi): void {
  api.on("after_tool_call", async (event, _ctx) => {
    try {
      if (!isBashLikeTool(event.toolName)) return;

      const ts = new Date().toISOString();
      const command = extractCommandString(event.params as Record<string, unknown>);
      const exitCode = extractExitCode(event.result, event.error);
      const durationMs =
        typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
          ? event.durationMs
          : -1;
      const sloTag = durationMs > SLO_THRESHOLD_MS ? " SLO_BREACH=true" : "";

      const lines: string[] = [];
      lines.push(
        `[${ts}] exit=${exitCode} duration_ms=${durationMs}${sloTag} cmd=${command.slice(0, 300)}\n`,
      );

      // result_head — head -c 4000 then collapse newlines and trim to 800.
      const resultText = extractResultText(event.result);
      if (resultText) {
        const head4k = resultText.slice(0, 4000);
        const oneLine = head4k.replace(/\n/g, " ");
        const truncated = oneLine.slice(0, 800);
        lines.push(`[${ts}] result_head: ${truncated}\n`);
      }

      appendLog(lines);
    } catch (err) {
      api.logger?.warn?.(
        `tsa-log-bash-exec failed tool=${event.toolName}: ${(err as Error).message}`,
      );
    }
  });
}
