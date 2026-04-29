import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAceOutputFilter } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-ace-output-filter",
  name: "TSA ACE Output Filter",
  description:
    "Filtra output do agente 0-ace extraindo apenas o bloco <<ACE>>...<<END>>. Caso o bloco esteja ausente mas haja markers, envia fallback. Texto sem markers passa direto.",
  register(api) {
    registerAceOutputFilter(api, (api as any)?.config ?? {});
  },
});
