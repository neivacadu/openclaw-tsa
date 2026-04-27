import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerPreToolCallBridge } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-pre-tool-call-bridge",
  name: "TSA pre_tool_call bash bridge",
  description:
    "Invokes legacy /opt/gold-standard/security-hooks/*.sh scripts from the native before_tool_call hook. Defense-in-depth: bash hooks keep running, this plugin propagates their block decision back to the agent so destructive commands are actually denied. Pairs with tsa-constitution (which has its own in-process checks).",
  register(api) {
    registerPreToolCallBridge(api);
  },
});
