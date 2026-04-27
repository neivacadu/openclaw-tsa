import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerBlockDestructivePlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-block-destructive",
  name: "TSA Block Destructive Commands",
  description:
    "Native TS migration of /opt/gold-standard/security-hooks/block-destructive.sh (S1). Hardline-blocks 20 destructive bash patterns (12 TSA original + 8 Hermes canonical) at before_tool_call. Replaces the bash bridge for this hook; takes priority over the .sh script which stays as backup.",
  register(api) {
    registerBlockDestructivePlugin(api);
  },
});
