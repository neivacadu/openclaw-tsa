import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { DeliveryRule, DeliveryTarget } from "./delivery-config.js";
import { sendTelegram, sendHttpWebhook } from "./delivery-targets.js";

/**
 * Dispatches a single diagnostic event through every matching rule.
 *
 * Match semantics:
 *   - "*"          matches any event type
 *   - "foo.*"      prefix wildcard, matches "foo.bar", "foo.baz.qux", etc.
 *   - "foo.bar"    exact match
 *
 * Throttling is per `(rule.match, target signature)` so two rules sharing a
 * target can each have independent throttle windows. The throttle window
 * starts at the moment of the first delivery and blocks new deliveries
 * within `throttle_ms` of that timestamp.
 */
export async function route(
  event: DiagnosticEventPayload,
  rules: DeliveryRule[],
  lastDelivery: Map<string, number>,
  logger: PluginLogger,
): Promise<void> {
  const now = Date.now();
  for (const rule of rules) {
    if (!matches(rule.match, event.type)) continue;

    const key = `${rule.match}|${signatureForTargets(rule.targets)}`;
    const throttleMs = rule.throttle_ms ?? 0;
    if (throttleMs > 0) {
      const last = lastDelivery.get(key);
      if (last !== undefined && now - last < throttleMs) continue;
    }
    lastDelivery.set(key, now);

    // Fan out targets in parallel; allSettled so a single bad target doesn't
    // poison the rest, and the agent never blocks on slow webhooks.
    await Promise.allSettled(
      rule.targets.map(async (target) => {
        try {
          await dispatch(target, event);
        } catch (err) {
          logger.warn(
            `tsa-webhook-direct-delivery: target ${target.type} failed for event=${event.type}: ${
              (err as Error)?.message ?? String(err)
            }`,
          );
        }
      }),
    );
  }
}

async function dispatch(target: DeliveryTarget, event: DiagnosticEventPayload): Promise<void> {
  const message = renderTemplate(target.template, event);
  if (target.type === "telegram") {
    await sendTelegram({
      chatId: target.chat_id,
      text: message,
      botToken: target.bot_token,
    });
    return;
  }
  if (target.type === "http") {
    await sendHttpWebhook({
      url: target.url,
      method: target.method ?? "POST",
      headers: target.headers,
      body: message,
    });
    return;
  }
}

export function matches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern === type) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keep the trailing dot
    return type.startsWith(prefix);
  }
  if (pattern.endsWith("*")) {
    return type.startsWith(pattern.slice(0, -1));
  }
  return false;
}

/**
 * Mustache-lite: replaces `{{key}}` with `String(event[key])`. The special
 * key `{{type}}` always resolves; `{{json}}` renders the whole event as
 * compact JSON for debug rules. Missing keys render as empty string.
 */
export function renderTemplate(tpl: string, event: DiagnosticEventPayload): string {
  return tpl.replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => {
    if (key === "json") {
      try {
        return JSON.stringify(event);
      } catch {
        return "";
      }
    }
    const value = readField(event as unknown as Record<string, unknown>, key);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  });
}

/**
 * Reads `a.b.c` style dotted paths so templates can pull nested fields, e.g.
 * `{{usage.input}}` from a model.usage event.
 */
function readField(obj: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return obj[path];
  const parts = path.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (cursor && typeof cursor === "object" && part in (cursor as object)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function signatureForTargets(targets: DeliveryTarget[]): string {
  return targets
    .map((t) => {
      if (t.type === "telegram") return `tg:${t.chat_id}`;
      return `http:${t.url}`;
    })
    .join(",");
}
