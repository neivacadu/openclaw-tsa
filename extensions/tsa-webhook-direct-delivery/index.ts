import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDeliveryService } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-webhook-direct-delivery",
  name: "TSA Webhook Direct-Delivery",
  description:
    "Zero-LLM webhook delivery (Hermes v0.11 pattern). Subscribes to OpenClaw diagnostic events and dispatches alerts straight to Telegram/HTTP without invoking the agent loop. Replaces bash hooks (notify-stop.sh, integrity-check.sh) with config-driven, throttled, fan-out delivery — saves tokens by skipping the LLM round-trip for purely diagnostic notifications.",
  register(api) {
    api.registerService(createDeliveryService());
  },
});
