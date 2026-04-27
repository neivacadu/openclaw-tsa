import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

export type DeliveryTarget =
  | {
      type: "telegram";
      chat_id: string;
      template: string;
      // bot_token override — if absent, falls back to env TELEGRAM_BOT_TOKEN
      bot_token?: string;
    }
  | {
      type: "http";
      url: string;
      method?: "POST" | "PUT" | "PATCH";
      headers?: Record<string, string>;
      template: string;
    };

export type DeliveryRule = {
  match: string; // exact event.type, or prefix wildcard "foo.*", or "*"
  throttle_ms?: number;
  targets: DeliveryTarget[];
};

const PLUGIN_ID = "tsa-webhook-direct-delivery";

/**
 * Pulls the rules array from `config.plugins.entries["tsa-webhook-direct-delivery"].config.rules`.
 * Returns [] for any malformed or missing config — the schema enforces shape
 * at load time, but we still defend at runtime so a bad reload can't crash
 * the diagnostic dispatcher.
 */
export function readDeliveryRules(config: OpenClawConfig | undefined): DeliveryRule[] {
  if (!config) return [];
  const plugins = (config as { plugins?: { entries?: Record<string, unknown> } }).plugins;
  const entry = plugins?.entries?.[PLUGIN_ID] as { config?: unknown } | undefined;
  const pluginConfig = entry?.config as { rules?: unknown } | undefined;
  const rules = pluginConfig?.rules;
  if (!Array.isArray(rules)) return [];

  const out: DeliveryRule[] = [];
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.match !== "string" || r.match.length === 0) continue;
    if (!Array.isArray(r.targets)) continue;
    const targets: DeliveryTarget[] = [];
    for (const t of r.targets) {
      const normalized = normalizeTarget(t);
      if (normalized) targets.push(normalized);
    }
    if (targets.length === 0) continue;
    out.push({
      match: r.match,
      throttle_ms: typeof r.throttle_ms === "number" && r.throttle_ms >= 0 ? r.throttle_ms : 0,
      targets,
    });
  }
  return out;
}

function normalizeTarget(raw: unknown): DeliveryTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  if (typeof t.template !== "string" || t.template.length === 0) return undefined;
  if (t.type === "telegram") {
    if (typeof t.chat_id !== "string" || t.chat_id.length === 0) return undefined;
    return {
      type: "telegram",
      chat_id: t.chat_id,
      template: t.template,
      ...(typeof t.bot_token === "string" && t.bot_token.length > 0
        ? { bot_token: t.bot_token }
        : {}),
    };
  }
  if (t.type === "http") {
    if (typeof t.url !== "string" || t.url.length === 0) return undefined;
    const method = t.method;
    const headers = t.headers;
    return {
      type: "http",
      url: t.url,
      template: t.template,
      ...(method === "POST" || method === "PUT" || method === "PATCH" ? { method } : {}),
      ...(headers && typeof headers === "object"
        ? { headers: headers as Record<string, string> }
        : {}),
    };
  }
  return undefined;
}
