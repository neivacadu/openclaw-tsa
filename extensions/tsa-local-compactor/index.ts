import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerLocalCompactor } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-local-compactor",
  name: "TSA Local Compactor",
  description:
    "Heuristic local compactor — injeta <summary> via before_prompt_build em cascades ACE→subagent. Zero LLM no caminho quente. enabled:false por default.",
  register(api) {
    registerLocalCompactor(api);
  },
});
