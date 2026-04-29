import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCascadeProgress } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-cascade-progress",
  name: "TSA Cascade Progress (MVP)",
  description:
    "ACK <3s + progress edit a cada 30s + fallback p99=180s nos hooks subagent_spawning/subagent_yielded (Camada 1 v1.5). enabled:false por default.",
  register(api) {
    registerCascadeProgress(api);
  },
});
