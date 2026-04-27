import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runBashHook } from "./hooks-runner.js";
import { hookForTool, isEditLikeTool, LOG_EDIT_INTENT_PATH } from "./tools-mapping.js";

const HOOK_TIMEOUT_MS = 5000;
const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "pre-tool-call-bridge.log");

/**
 * Registers the bash-hook bridge on the supplied plugin API.
 *
 * For each before_tool_call event we look up a bash hook (hookForTool):
 *   - if there's a gating hook, we run it synchronously; exit 2 -> block
 *   - if the tool is edit-like, we mirror the call to log-edit-intent.sh as
 *     a fire-and-forget (never blocks)
 *   - tools without any mapping are passed through with no overhead beyond
 *     the lookup
 *
 * Failures are fail-safe: any timeout, spawn error or unexpected exit code
 * is treated as pass-through and logged. The bash hooks still run on their
 * own (the legacy hook registrations stay in place) so this plugin is
 * additive, not a replacement.
 */
export function registerPreToolCallBridge(api: OpenClawPluginApi): void {
  api.on("before_tool_call", async (event, ctx) => {
    const toolName = event.toolName ?? "";
    const params = (event.params as Record<string, unknown> | undefined) ?? {};

    const hookPath = hookForTool(toolName);

    // Fire-and-forget mirror to log-edit-intent.sh for Edit/Write-style tools.
    // Never awaited — if it crashes we don't care.
    if (isEditLikeTool(toolName)) {
      void runBashHook(
        LOG_EDIT_INTENT_PATH,
        {
          tool_name: toolName,
          tool_input: params,
          agent_id: ctx?.agentId,
          session_id: ctx?.sessionId,
        },
        { timeoutMs: HOOK_TIMEOUT_MS, neverBlock: true },
      ).catch(() => {
        // intentional: log-edit failures must not affect tool execution
      });
    }

    if (!hookPath) {
      return undefined;
    }

    const result = await runBashHook(
      hookPath,
      {
        tool_name: toolName,
        tool_input: params,
        agent_id: ctx?.agentId,
        session_id: ctx?.sessionId,
      },
      { timeoutMs: HOOK_TIMEOUT_MS },
    );

    if (result.blocked) {
      const reason = result.reason ?? "blocked";
      appendLog(toolName, `BLOCKED hook=${path.basename(hookPath)} reason=${reason}`);
      api.logger.warn?.(
        `tsa-pre-tool-call-bridge blocked tool=${toolName} hook=${path.basename(hookPath)}: ${reason}`,
      );
      return {
        block: true,
        blockReason: `bash hook blocked: ${reason}`,
      };
    }

    if (result.fallbackReason) {
      appendLog(
        toolName,
        `PASSTHROUGH hook=${path.basename(hookPath)} fallback=${result.fallbackReason}`,
      );
      api.logger.warn?.(
        `tsa-pre-tool-call-bridge pass-through tool=${toolName} reason=${result.fallbackReason}`,
      );
      return undefined;
    }

    appendLog(toolName, `ALLOWED hook=${path.basename(hookPath)}`);
    return undefined;
  });
}

function appendLog(toolName: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] tool=${toolName} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // intentional: never break tool execution because of logging IO
  }
}
