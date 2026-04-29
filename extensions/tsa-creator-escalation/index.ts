import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCreatorEscalation } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-creator-escalation",
  name: "TSA Creator Escalation (MVP)",
  description:
    "Escalation 3 niveis (30min ACE responde ETA / 24h stale / 48h DM Cadu) pra skills criadas pelo CREATOR aguardando aprovacao Cadu via topico Operacoes 4770. enabled:false por default.",
  register(api) {
    registerCreatorEscalation(api);
  },
});
