import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { checkConstitution, type ConstitutionViolation } from "./checks.js";
import { appendLog } from "./rules.js";

/**
 * Registers the TSA Constitution before_tool_call hook on the supplied plugin API.
 *
 * Mirrors the semantics of /home/ace-tsia/.openclaw/hooks/constitution.sh but
 * runs in-process. Logs to /home/ace-tsia/.openclaw/logs/constitution.log in
 * the same line format ("[ts] action=... ALLOWED" / "BLOCKED rule=N reason=...")
 * so existing dashboards keep working.
 */
export function registerConstitutionPlugin(api: OpenClawPluginApi): void {
  api.on("before_tool_call", async (event, _ctx) => {
    const action = mapToolToAction(event.toolName);
    try {
      const violation: ConstitutionViolation | null = await checkConstitution({
        toolName: event.toolName,
        params: event.params,
      });
      if (violation) {
        appendLog(action, `BLOCKED rule=${violation.rule} reason=${violation.reason}`);
        api.logger.warn(
          `tsa-constitution blocked tool=${event.toolName} rule=${violation.rule}: ${violation.reason}`,
        );
        return {
          block: true,
          blockReason: `Constitution violation (rule ${violation.rule}): ${violation.reason}`,
        };
      }
      appendLog(action, "ALLOWED");
      return undefined;
    } catch (err) {
      // Fail-open on plugin errors: never break tool execution because of a
      // logger/IO problem here. The bash hook still runs in parallel.
      api.logger.error(
        `tsa-constitution check failed for tool=${event.toolName}: ${(err as Error).message}`,
      );
      return undefined;
    }
  });
}

/**
 * Project the OpenClaw tool name onto the {read,write,save,exec,unknown}
 * vocabulary used by the original bash hook so log lines stay grep-compatible.
 */
function mapToolToAction(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower.includes("read") || lower.includes("get") || lower.includes("fetch")) return "read";
  if (lower.includes("write") || lower.includes("create")) return "write";
  if (lower.includes("save") || lower.includes("upload")) return "save";
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) return "exec";
  return toolName || "unknown";
}
