import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerTransformToolResultPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-transform-tool-result",
  name: "TSA Transform Tool Result",
  description:
    "Sanitizes agent tool-result output before the agent sees it: redacts API keys / OAuth tokens / ace-* paths, neutralizes prompt-injection markers, and truncates oversized text blocks. Registered as agentToolResultMiddleware (pi + codex runtimes).",
  register(api) {
    registerTransformToolResultPlugin(api);
  },
});
