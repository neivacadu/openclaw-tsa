import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { findDestructiveMatch } from "./patterns.js";

const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "block-destructive.log");

/**
 * "--allow-destructive" sentinel — same convention used by block-destructive.sh.
 * If callers explicitly opt in we let it through (still logged at warn level).
 */
const DESTRUCTIVE_OVERRIDE = /--allow-destructive\b/;

/**
 * Tools subject to destructive-command gating. Match is case-insensitive.
 * Stays in sync with tsa-pre-tool-call-bridge tools-mapping (BLOCKING_TOOLS).
 */
const BLOCKING_TOOLS = new Set(["bash", "shell", "execute", "exec", "run-shell"]);

function isBashLikeTool(toolName: string): boolean {
  if (!toolName) return false;
  return BLOCKING_TOOLS.has(toolName.toLowerCase());
}

function extractCommandString(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null;
  for (const key of ["command", "cmd", "script", "input"]) {
    const v = params[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Append a log line in the same format produced by block-destructive.sh so
 * existing grep/dashboards keep working. Best-effort — never throws.
 */
function appendLog(level: "BLOCKED" | "ALLOWED", reason: string, command: string): void {
  const ts = new Date().toISOString();
  const cmd = command.slice(0, level === "BLOCKED" ? 200 : 120);
  const line =
    level === "BLOCKED"
      ? `[${ts}] BLOCKED reason=${reason} cmd=${cmd}\n`
      : `[${ts}] ALLOWED cmd=${cmd}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // never break tool execution because of logging IO
  }
}

/**
 * Registers the TSA block-destructive before_tool_call hook on the plugin API.
 *
 * Runs in-process and takes priority over the bash hook (which stays installed
 * as a backup until validated >=7 days). Mirrors the bash hook exit contract:
 *   - destructive match -> { block: true, blockReason: "..." }
 *   - otherwise         -> undefined (pass-through)
 *
 * Errors are fail-open: we log and pass through. The .sh hook still runs in
 * parallel via tsa-pre-tool-call-bridge, so a TS-side bug never lets a
 * destructive command through silently.
 */
export function registerBlockDestructivePlugin(api: OpenClawPluginApi): void {
  api.on("before_tool_call", async (event, _ctx) => {
    try {
      if (!isBashLikeTool(event.toolName)) return undefined;
      const command = extractCommandString(event.params as Record<string, unknown>);
      if (!command) return undefined;

      // Explicit opt-in escape hatch (logged at warn level).
      if (DESTRUCTIVE_OVERRIDE.test(command)) {
        api.logger?.warn?.(
          `tsa-block-destructive: --allow-destructive override used cmd=${command.slice(0, 200)}`,
        );
        appendLog("ALLOWED", "override", command);
        return undefined;
      }

      const match = findDestructiveMatch(command);
      if (match) {
        appendLog("BLOCKED", match.reason, command);
        api.logger?.warn?.(
          `tsa-block-destructive blocked tool=${event.toolName} reason=${match.reason}`,
        );
        return {
          block: true,
          blockReason: `BLOCKED: ${match.reason}`,
        };
      }

      appendLog("ALLOWED", "ok", command);
      return undefined;
    } catch (err) {
      // Fail-open: the bash hook bridge still runs and will catch this.
      api.logger?.error?.(
        `tsa-block-destructive failed for tool=${event.toolName}: ${(err as Error).message}`,
      );
      return undefined;
    }
  });
}
