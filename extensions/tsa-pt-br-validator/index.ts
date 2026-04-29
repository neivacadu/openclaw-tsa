import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerPtBrValidatorPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-pt-br-validator",
  name: "TSA PT-BR Validator",
  description:
    "after_tool_call hook que valida texto pt-BR gerado por Write/Edit/Bash heredoc/WebFetch save. Detecta palavras vigiadas (regex), anglicismos sem traducao, e gera score 0-10. monitorOnly:true (default) = warning + metrica. monitorOnly:false = deny + sugestao de correcao.",
  register(api) {
    registerPtBrValidatorPlugin(api);
  },
});
