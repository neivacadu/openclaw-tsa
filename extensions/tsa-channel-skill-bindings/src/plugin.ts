import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { readBindingsFromConfig, resolveSkills } from "./resolver.js";

const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "channel-skill-bindings.log");

/**
 * Per-session resolution state. Filled in `inbound_claim` (where we know the
 * channel + conversation ids) and consumed in `before_prompt_build` (where we
 * have the prompt being built but no longer have the original channel info).
 *
 * Keyed by `sessionKey` so concurrent runs across channels stay isolated.
 * Keys are evicted on `session_end`. We also cap the map size so a runaway
 * inbound stream cannot grow the cache without bound (LRU-ish: oldest keys
 * dropped when MAX exceeded).
 */
type Resolution = {
  provider: string;
  channelId: string;
  parentId?: string;
  skills: string[];
};

const MAX_CACHE_KEYS = 1024;
const cache = new Map<string, Resolution>();

function rememberResolution(sessionKey: string, resolution: Resolution): void {
  // Refresh insertion order so trimming oldest entries is correct.
  cache.delete(sessionKey);
  cache.set(sessionKey, resolution);
  while (cache.size > MAX_CACHE_KEYS) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
}

function recallResolution(sessionKey: string | undefined): Resolution | undefined {
  if (!sessionKey) return undefined;
  return cache.get(sessionKey);
}

/**
 * Registers the channel -> skill binding resolver hooks.
 *
 * Wiring (mirrors Hermes 8fb861ea behaviour, generalized to telegram +
 * discord):
 *
 *   1. `inbound_claim` — fires on every inbound message that the agent is
 *      about to claim. We extract the channel provider (telegram / discord /
 *      slack / ...) and the conversation id (chat_id, channel_id, guild
 *      thread, ...). We resolve skills via `resolveSkills` and stash the
 *      result keyed by `sessionKey`. No mutation of the event itself.
 *
 *   2. `before_prompt_build` — fires when the prompt is being assembled. We
 *      look up the stashed resolution by `sessionKey` and, if present and
 *      non-empty, return `prependSystemContext` with a SKILL_PRELOAD block.
 *      This keeps the injected text in the *system* prompt so prompt caching
 *      stays effective across turns within the same channel.
 *
 *   3. `session_end` — clear the per-session cache entry.
 *
 * Failure mode is fail-safe: any error inside the resolver is caught, logged
 * via `api.logger`, and the agent runs without skill preloading rather than
 * crashing. The legacy bash hooks (if any) keep running independently, so
 * this plugin is purely additive.
 */
export function registerChannelSkillBindingsPlugin(api: OpenClawPluginApi): void {
  api.on("inbound_claim", async (event, ctx) => {
    try {
      const provider = (event.channel ?? "").toLowerCase();
      if (!provider) return undefined;

      // Conversation id is the primary lookup. Telegram: chat id. Discord:
      // channel id (string for guild channels). Slack: channel id. Falls
      // back to threadId / senderId so DMs without a "conversation" still
      // resolve via the senderId default.
      const channelId =
        toStringId(event.conversationId) ??
        toStringId(event.threadId) ??
        toStringId(event.senderId) ??
        "";

      const parentId = toStringId(event.parentConversationId);

      const config = (api.config ?? {}) as Record<string, unknown>;
      const bindings = readBindingsFromConfig(config, provider);
      if (bindings.length === 0) return undefined;

      const skills = resolveSkills(bindings, channelId, parentId);
      const sessionKey = ctx?.sessionKey ?? event.sessionKey;
      if (!sessionKey) {
        appendLog(
          provider,
          `NO_SESSION_KEY channel=${channelId || "(unknown)"} skills=${skills.length}`,
        );
        return undefined;
      }

      rememberResolution(sessionKey, {
        provider,
        channelId,
        parentId,
        skills,
      });

      appendLog(
        provider,
        `RESOLVED sessionKey=${sessionKey} channel=${channelId || "(default)"} parent=${parentId ?? "-"} skills=${
          skills.length === 0 ? "(none)" : skills.join(",")
        }`,
      );
      return undefined;
    } catch (err) {
      api.logger.warn?.(
        `tsa-channel-skill-bindings inbound_claim failed: ${(err as Error).message}`,
      );
      return undefined;
    }
  });

  api.on("before_prompt_build", async (_event, ctx) => {
    try {
      const sessionKey = ctx?.sessionKey;
      const resolution = recallResolution(sessionKey);
      if (!resolution || resolution.skills.length === 0) return undefined;

      const prependSystemContext = buildSkillPreloadContext(resolution);
      appendLog(
        resolution.provider,
        `INJECTED sessionKey=${sessionKey ?? "-"} channel=${resolution.channelId || "(default)"} skills=${resolution.skills.join(",")}`,
      );
      return { prependSystemContext };
    } catch (err) {
      api.logger.warn?.(
        `tsa-channel-skill-bindings before_prompt_build failed: ${(err as Error).message}`,
      );
      return undefined;
    }
  });

  api.on("session_end", async (event) => {
    try {
      const key = event.sessionKey;
      if (!key) return undefined;
      cache.delete(key);
      return undefined;
    } catch {
      // intentional: cleanup must not break session-end flow
      return undefined;
    }
  });
}

/**
 * Renders the skill list as a system-prompt block. Format is grep-friendly so
 * downstream tools (logs, agent skill loaders) can detect it. The wording is
 * an instruction the agent can follow but does not require — if the named
 * skill does not exist the agent simply ignores the hint.
 */
function buildSkillPreloadContext(resolution: Resolution): string {
  const lines: string[] = [];
  lines.push("[TSA-CHANNEL-SKILL-BINDINGS]");
  lines.push(
    `# Channel '${resolution.provider}/${resolution.channelId || "default"}' has preloaded skills.`,
  );
  lines.push("# Treat these skills as auto-loaded for the current conversation:");
  for (const skill of resolution.skills) {
    lines.push(`- ${skill}`);
  }
  lines.push(
    "# When a request matches one of these skills, prefer it over equivalent ad-hoc reasoning.",
  );
  lines.push("[/TSA-CHANNEL-SKILL-BINDINGS]");
  return lines.join("\n");
}

function toStringId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function appendLog(provider: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] provider=${provider} ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // intentional: never break agent flow because of logging IO
  }
}

/** Exposed for unit tests / smoke harness. */
export const __TEST_INTERNALS = {
  cache,
  rememberResolution,
  recallResolution,
};
