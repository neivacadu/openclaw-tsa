import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the bot token in the same order as notify-stop.sh:
 *   1. process.env.TELEGRAM_BOT_TOKEN
 *   2. ~/.openclaw/.env  (TELEGRAM_BOT_TOKEN=...)
 *
 * Returns null if neither source has a token; caller skips the POST.
 */
export function resolveBotToken(): string | null {
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const envFile = path.join(os.homedir(), ".openclaw", ".env");
  try {
    const content = fs.readFileSync(envFile, "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(/^TELEGRAM_BOT_TOKEN=(.*)$/);
      if (m) {
        return m[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // file missing or unreadable -> fall through
  }
  return null;
}

/** Default chat id when neither config nor env supplies one. */
const DEFAULT_CHAT_ID = "601478643";

export function resolveChatId(configured: string | undefined): string {
  if (configured && configured.length > 0) return configured;
  const fromEnv = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEFAULT_CHAT_ID;
}

export type SendOptions = {
  timeoutMs: number;
};

export type SendResult = {
  ok: boolean;
  status?: number;
  error?: string;
};

/**
 * Send a Telegram message via the Bot HTTP API. Bounded by AbortController so
 * we never block agent finalize for more than `timeoutMs`. Errors are
 * swallowed at the call site and logged — this is best-effort notification.
 *
 * Uses global `fetch` (Node 18+, which OpenClaw already requires).
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  opts: SendOptions,
): Promise<SendResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chat_id: chatId, text }).toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
