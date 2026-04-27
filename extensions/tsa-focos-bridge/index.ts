import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerFocosBridge } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-focos-bridge",
  name: "TSA FOCOS routing bridge",
  description:
    "Invokes the FOCOS routing engine (Python MVP at /opt/focos/cascade.py) before the agent reasons. The CLI returns a JSON decision (action / target / confidence / reasoning) that we inject into the system prompt via `prependSystemContext` so prompt caching survives. Fail-safe: any subprocess error, timeout, or invalid JSON falls through and lets the agent decide on its own. Pairs with the FOCOS audit log in /opt/focos/focos.db so every decision is replayable.",
  register(api) {
    registerFocosBridge(api);
  },
});
