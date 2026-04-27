import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { sanitize } from "./sanitizers.js";
import { truncate } from "./truncate.js";

/**
 * Maximum bytes we keep per text block before truncating. 10 KiB matches the
 * informal TSA convention used by the bash hooks; tools that legitimately need
 * larger payloads (Read on a big file, Bash with verbose stdout) will be
 * truncated with a clear marker so the agent sees that bytes were dropped.
 */
const MAX_BYTES = 10 * 1024;

/**
 * Registers the TSA tool-result middleware. Runs in the post-tool-execution
 * pipeline for both pi and codex runtimes (declared in
 * openclaw.plugin.json#contracts.agentToolResultMiddleware).
 *
 * Contract:
 *   - On success, returns \`{ result }\` with the same shape as the input,
 *     but with each text content block sanitized and truncated.
 *   - On any error, returns \`undefined\` (pass-through). We must never break
 *     tool execution because of a sanitizer bug.
 */
export function registerTransformToolResultPlugin(api: OpenClawPluginApi): void {
  api.registerAgentToolResultMiddleware(
    async (event, _ctx) => {
      try {
        const result = event.result;
        if (!result || !Array.isArray(result.content)) {
          return undefined;
        }

        let mutated = false;
        const newContent = result.content.map((block) => {
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string"
          ) {
            const original = (block as { text: string }).text;
            let next = sanitize(original);
            next = truncate(next, MAX_BYTES);
            if (next !== original) {
              mutated = true;
              return { ...block, text: next };
            }
          }
          return block;
        });

        if (!mutated) {
          // Nothing changed -> pass-through to avoid unnecessary object churn.
          return undefined;
        }

        return {
          result: {
            ...result,
            content: newContent,
          },
        };
      } catch (err) {
        // Fail-safe: log and pass through. Never break the tool result chain.
        try {
          api.logger.warn(
            `tsa-transform-tool-result middleware error tool=${event.toolName}: ${(err as Error).message}`,
          );
        } catch {
          // logger may not be available; swallow.
        }
        return undefined;
      }
    },
    { runtimes: ["pi", "codex"] },
  );
}
