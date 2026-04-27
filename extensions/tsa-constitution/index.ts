import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerConstitutionPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-constitution",
  name: "TSA Constitution Enforcement",
  description:
    "Enforces TSA Constitution rules (4 auth, 7 opus-latest, 11 destructive, 14 pt-BR) via before_tool_call hook. POC migration of /home/ace-tsia/.openclaw/hooks/constitution.sh to native TS plugin.",
  register(api) {
    registerConstitutionPlugin(api);
  },
});
