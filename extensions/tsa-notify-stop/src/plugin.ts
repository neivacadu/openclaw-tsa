import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runGates, formatGateResults } from "./gates.js";
import { resolveBotToken, resolveChatId, sendTelegramMessage } from "./telegram.js";

const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "notify-stop.log");

/**
 * "Normal" stop reasons: do NOT fire a Telegram alert. Mirrors the bash hook
 * case statement: normal | user | completed | "".
 */
const NORMAL_REASONS = new Set(["normal", "user", "completed", ""]);

type PluginConfig = {
  telegramChatId?: string;
  telegramTimeoutMs?: number;
};

function appendLog(line: string): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line.endsWith("\n") ? line : `${line}\n`);
  } catch {
    // never break finalize because of logging IO
  }
}

/**
 * Best-effort extract of the agent stop reason. The before_agent_finalize
 * event doesn't include `reason` directly, so we look at the same env vars
 * the bash hook used — they're set by the OpenClaw runtime when finalize is
 * triggered by something other than a clean turn end.
 */
function resolveStopReason(): string {
  return process.env.OPENCLAW_STOP_REASON ?? "unknown";
}

function resolveDurationMs(): number {
  const raw =
    process.env.OPENCLAW_AGENT_DURATION_MS ?? process.env.OPENCLAW_HOOK_DURATION_MS ?? "-1";
  const n = Number(raw);
  return Number.isFinite(n) ? n : -1;
}

function resolveJobId(): string | undefined {
  return process.env.OPENCLAW_CRON_JOB_ID ?? process.env.OPENCLAW_JOB_ID ?? undefined;
}

function getCloneName(): string {
  // Bash hook used `basename "$HOME"`; replicate.
  return path.basename(os.homedir());
}

/**
 * Registers the TSA notify-stop hook on before_agent_finalize.
 *
 * Always returns `{ action: "continue" }` — we never block finalize. The
 * logical structure mirrors notify-stop.sh:
 *
 *   1. Run gates (constitution, ratings) → log result
 *   2. If reason ∈ NORMAL_REASONS → exit
 *   3. Else: resolve token + chat → send Telegram (bounded timeout)
 *
 * Errors are swallowed: notification is best-effort.
 */
export function registerNotifyStopPlugin(api: OpenClawPluginApi): void {
  api.on("before_agent_finalize", async (event, _ctx) => {
    try {
      const ts = new Date().toISOString();
      const cloneName = getCloneName();
      const reason = resolveStopReason();
      const durationMs = resolveDurationMs();
      const sessionId = event.sessionId ?? process.env.OPENCLAW_SESSION_ID ?? "unknown";
      const jobId = resolveJobId();

      const gates = runGates();
      const gateString = formatGateResults(gates);

      let logLine = `[${ts}] STOP clone=${cloneName} reason=${reason} duration_ms=${durationMs} session=${sessionId}`;
      if (jobId) logLine += ` job_id=${jobId}`;
      logLine += ` gates="${gateString}"`;
      appendLog(logLine);

      if (NORMAL_REASONS.has(reason)) {
        return { action: "continue" };
      }

      const config = ((api as unknown as { config?: PluginConfig }).config ?? {}) as PluginConfig;
      const token = resolveBotToken();
      if (!token) {
        appendLog(`[${ts}] no token, skipping telegram`);
        return { action: "continue" };
      }
      const chatId = resolveChatId(config.telegramChatId);
      const timeoutMs =
        typeof config.telegramTimeoutMs === "number" && config.telegramTimeoutMs > 0
          ? config.telegramTimeoutMs
          : 8000;

      const message = `Ace stopped: ${cloneName} · reason: ${reason} · duration_ms: ${durationMs} · gates: ${gateString} · ${ts}`;
      const result = await sendTelegramMessage(token, chatId, message, { timeoutMs });
      if (!result.ok) {
        appendLog(
          `[${ts}] telegram failed status=${result.status ?? "?"} error=${result.error ?? "?"}`,
        );
      } else {
        appendLog(`[${ts}] telegram sent status=${result.status ?? "?"}`);
      }
    } catch (err) {
      api.logger?.warn?.(`tsa-notify-stop failed: ${(err as Error).message}`);
    }
    return { action: "continue" };
  });
}
