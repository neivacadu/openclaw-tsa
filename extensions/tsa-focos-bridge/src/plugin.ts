import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { decide, type FocosCallResult } from "./focos-cli.js";

const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "focos-bridge.log");

type FocosBridgeConfig = {
  binPath?: string;
  timeoutMs?: number;
  /** If set, decisions below this confidence are not injected (still logged). */
  minConfidence?: number;
};

/**
 * Registers the FOCOS routing bridge.
 *
 * We hook `before_agent_start` because it is the legacy combined hook that
 * exposes both the user prompt AND lets us return prompt-mutation fields
 * (`prependSystemContext`). That is exactly the shape we need: read the
 * prompt -> ask FOCOS -> prepend a routing hint to the system prompt.
 *
 * We deliberately use `prependSystemContext` (not `prependContext`) so the
 * hint becomes part of the cacheable system prefix — re-running FOCOS
 * every turn would otherwise burn cache for nothing.
 *
 * Fail-safe contract: any error path returns `undefined` so the agent
 * proceeds with no hint. FOCOS should never block the agent loop.
 */
export function registerFocosBridge(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as FocosBridgeConfig;

  api.on("before_agent_start", async (event, ctx) => {
    const prompt = (event?.prompt ?? "").trim();
    if (!prompt) {
      return undefined;
    }

    let result: FocosCallResult;
    try {
      result = await decide(
        prompt,
        { sessionId: ctx?.sessionId, agentId: ctx?.agentId },
        { binPath: cfg.binPath, timeoutMs: cfg.timeoutMs },
      );
    } catch (err) {
      // decide() should never throw — if it does, treat as pass-through.
      appendLog(`UNEXPECTED throw: ${(err as Error).message}`);
      return undefined;
    }

    if (!result.ok) {
      appendLog(`PASSTHROUGH reason=${result.reason}`);
      api.logger.warn?.(`tsa-focos-bridge pass-through: ${result.reason}`);
      return undefined;
    }

    const { decision } = result;
    if (typeof cfg.minConfidence === "number" && decision.confidence < cfg.minConfidence) {
      appendLog(
        `SKIPPED action=${decision.action} target=${decision.target} confidence=${decision.confidence} below=${cfg.minConfidence}`,
      );
      return undefined;
    }

    appendLog(
      `INJECTED action=${decision.action} target=${decision.target} confidence=${decision.confidence}`,
    );

    return {
      // System-prefix slot keeps the hint inside the cacheable prefix —
      // FOCOS still re-runs every turn (decisions are dynamic), but the
      // hint text varies in only ~80 bytes, so prefix-cache invalidation
      // stays bounded.
      prependSystemContext: formatHint(decision),
    };
  });
}

function formatHint(decision: {
  action: string;
  target: string;
  confidence: number;
  reasoning: string;
}): string {
  // Compact, machine-friendly block. Skills / agents that know about FOCOS
  // can parse the FOCOS_DECISION line; everyone else just sees a short
  // explanatory note.
  const lines = [
    "<focos-routing-hint>",
    `FOCOS_DECISION action=${decision.action} target=${decision.target} confidence=${decision.confidence.toFixed(
      2,
    )}`,
    `reasoning: ${decision.reasoning}`,
    "Treat this as advisory: prefer the suggested target/skill when it fits, but you remain the authority. If no skill matches the suggestion, fall back to your default reasoning.",
    "</focos-routing-hint>",
  ];
  return lines.join("\n");
}

function appendLog(message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // intentional: never break the agent loop because of logging IO
  }
}
