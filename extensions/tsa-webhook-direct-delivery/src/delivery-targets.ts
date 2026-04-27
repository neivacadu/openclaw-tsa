/**
 * Concrete delivery transports. Each function:
 *   - validates inputs cheaply
 *   - opens a single short-lived fetch with a timeout
 *   - throws on transport error or non-2xx (caller catches and logs)
 *
 * No retries here on purpose. The router is fire-and-forget on hot paths;
 * adding retries would amplify load during incidents (e.g. when integrity
 * violations are flooding). If durable retry is needed it belongs in a
 * separate queue plugin.
 */

const DEFAULT_TIMEOUT_MS = 5000;

export type SendTelegramOptions = {
  chatId: string;
  text: string;
  // Optional explicit bot token; falls back to TELEGRAM_BOT_TOKEN env.
  botToken?: string;
  timeoutMs?: number;
};

export async function sendTelegram(opts: SendTelegramOptions): Promise<void> {
  const token = opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("telegram: missing bot token (no botToken option, no TELEGRAM_BOT_TOKEN env)");
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({
    chat_id: opts.chatId,
    text: truncateForTelegram(opts.text),
    // disable_web_page_preview to keep alerts compact
    disable_web_page_preview: true,
  });
  await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

export type SendHttpWebhookOptions = {
  url: string;
  method: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  body: string;
  timeoutMs?: number;
};

export async function sendHttpWebhook(opts: SendHttpWebhookOptions): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  await fetchWithTimeout(
    opts.url,
    {
      method: opts.method,
      headers,
      body: opts.body,
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      // Drain body so the socket can be reused; cap to avoid log bloat.
      let snippet = "";
      try {
        const txt = await res.text();
        snippet = txt.slice(0, 200);
      } catch {
        // ignore — we already have a status code
      }
      throw new Error(`http ${res.status} ${res.statusText}${snippet ? `: ${snippet}` : ""}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Telegram caps sendMessage text at 4096 UTF-16 code units. Truncate
// defensively with an ellipsis so a verbose event payload can't make the
// whole alert get rejected.
const TELEGRAM_MAX_CHARS = 4000;

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  return `${text.slice(0, TELEGRAM_MAX_CHARS - 3)}...`;
}
