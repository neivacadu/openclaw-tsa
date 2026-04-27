import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { readDeliveryRules, type DeliveryRule } from "./delivery-config.js";
import { route } from "./delivery-router.js";

/**
 * Background service that subscribes to OpenClaw diagnostic events and
 * dispatches alerts straight to Telegram/HTTP webhooks — bypassing the
 * agent loop entirely. This is the Hermes v0.11 "webhook direct-delivery
 * zero-LLM" pattern: notifications go to their destination without
 * spending model tokens on a round-trip through the LLM.
 *
 * Failure mode is fail-silent: any error in delivery (network, JSON, bad
 * config) is logged at warn level and dropped. The plugin must NEVER throw
 * an exception that propagates back into the diagnostic event dispatcher,
 * because diagnostic events are fired from hot paths (tool calls, model
 * calls, message delivery) and a synchronous throw would kill the agent.
 */
export function createDeliveryService(): OpenClawPluginService {
  let unsubscribe: (() => void) | undefined;
  // Throttle state is keyed by `${rule.match}|${target_signature}` and lives
  // for the lifetime of the service. Reset on stop().
  const lastDelivery = new Map<string, number>();

  return {
    id: "tsa-webhook-direct-delivery",
    start(ctx: OpenClawPluginServiceContext) {
      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.warn(
          "tsa-webhook-direct-delivery: internalDiagnostics capability unavailable; plugin idle",
        );
        return;
      }

      const rules: DeliveryRule[] = readDeliveryRules(ctx.config);
      if (rules.length === 0) {
        ctx.logger.info("tsa-webhook-direct-delivery: no delivery rules configured; plugin idle");
        return;
      }

      ctx.logger.info(
        `tsa-webhook-direct-delivery: subscribed with ${rules.length} delivery rule(s)`,
      );

      unsubscribe = subscribe((event: DiagnosticEventPayload) => {
        // Deliberately fire-and-forget. Diagnostic listeners are sync, so we
        // hand off to the router asynchronously and swallow rejections — we
        // must not propagate exceptions back to the dispatcher.
        try {
          void route(event, rules, lastDelivery, ctx.logger).catch((err) => {
            ctx.logger.warn(
              `tsa-webhook-direct-delivery: route() rejected for event=${event.type}: ${
                (err as Error)?.message ?? String(err)
              }`,
            );
          });
        } catch (err) {
          ctx.logger.warn(
            `tsa-webhook-direct-delivery: route() threw for event=${event.type}: ${
              (err as Error)?.message ?? String(err)
            }`,
          );
        }
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      lastDelivery.clear();
    },
  };
}
