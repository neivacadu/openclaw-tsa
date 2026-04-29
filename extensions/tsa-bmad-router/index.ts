import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerBmadRouter } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-bmad-router",
  name: "TSA BMAD Router (P1-C)",
  description:
    "Auto-activates BMAD personas em spawns complexos do JOKER via hook subagent_spawning. Heurística zero-LLM (keywords +2 / stakeholders/multi-step/long +1, banda >=3). Picks persona por fase canônica BMAD (1-analysis/2-plan-workflows/3-solutioning/4-implementation), injeta persona-flag em systemPromptPrepend e estampa metadata.bmad pra phase-hint da próxima cascade. Default monitorOnly=true · enabled:false. Lab oficial: ace-tsia-beta.",
  register(api) {
    registerBmadRouter(api);
  },
});
