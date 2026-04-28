import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerForceSpawn } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-force-spawn",
  name: "TSA Force Spawn (5-agents flow enforcement)",
  description:
    "Blocks executor tools (web_fetch, browser, playwright) in ACE main session, forcing delegation via sessions_spawn(0-joker). Implements 5-agents flow enforcement.",
  register(api) {
    registerForceSpawn(api);
  },
});
