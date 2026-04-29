import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCascadeMonitor } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-cascade-monitor",
  name: "TSA Cascade Monitor (MVP)",
  description:
    "MVP daily cap + Telegram alerts pro hook subagent_spawning (Camada 1 v1.5). enabled:false por default.",
  register(api) {
    registerCascadeMonitor(api);
  },
});
