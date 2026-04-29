import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerRuleValidator } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-rule-validator",
  name: "TSA Rule Validator",
  description:
    "Valida regras YAML (schema + cross-refs + semver) em /opt/tsa-ace-master/rules/. Hook gateway_start. enabled:false default.",
  register(api) {
    registerRuleValidator(api);
  },
});
