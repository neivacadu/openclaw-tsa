import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "edit-intent.log");

/**
 * Edit-style tools we want to capture. Match is case-insensitive on the tool
 * name. Stays in sync with tsa-pre-tool-call-bridge tools-mapping
 * (EDIT_LIKE_TOOLS).
 */
const EDIT_LIKE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "multi-edit",
  "create",
  "create-file",
  "update-file",
]);

function isEditLikeTool(toolName: string): boolean {
  if (!toolName) return false;
  return EDIT_LIKE_TOOLS.has(toolName.toLowerCase());
}

type EditDetails = {
  op: "edit" | "write" | "unknown";
  path: string;
  size: number;
};

/**
 * Reproduces the python-extracted fields produced by log-edit-intent.sh:
 *   - path  ← file_path | path | filePath | "?"
 *   - op    ← "edit" if old_string present, "write" if content present
 *   - size  ← (content || new_string).length
 */
function extractDetails(params: Record<string, unknown> | undefined): EditDetails {
  const p = params ?? {};
  const pathStr =
    typeof p.file_path === "string"
      ? p.file_path
      : typeof p.path === "string"
        ? p.path
        : typeof p.filePath === "string"
          ? p.filePath
          : "?";

  let op: EditDetails["op"] = "unknown";
  if (typeof p.old_string === "string") op = "edit";
  else if (typeof p.content === "string") op = "write";

  let size = 0;
  if (typeof p.content === "string") size = p.content.length;
  else if (typeof p.new_string === "string") size = p.new_string.length;

  return { op, path: pathStr, size };
}

function appendLog(toolName: string, details: EditDetails): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] tool=${toolName} op=${details.op} path=${details.path} size=${details.size}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // never break tool execution because of logging IO
  }
}

/**
 * Registers the TSA log-edit-intent before_tool_call hook.
 *
 * Always non-blocking: we return undefined unconditionally. Mirrors the bash
 * hook line format so existing grep pipelines keep working.
 *
 * Errors are swallowed: this is observability, not enforcement.
 */
export function registerLogEditIntentPlugin(api: OpenClawPluginApi): void {
  api.on("before_tool_call", async (event, _ctx) => {
    try {
      if (!isEditLikeTool(event.toolName)) return undefined;
      const details = extractDetails(event.params as Record<string, unknown>);
      appendLog(event.toolName, details);
    } catch (err) {
      // intentional: never block on logging failures
      api.logger?.warn?.(
        `tsa-log-edit-intent failed tool=${event.toolName}: ${(err as Error).message}`,
      );
    }
    return undefined;
  });
}
