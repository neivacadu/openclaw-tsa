import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSubagentRedirect } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-subagent-redirect",
  name: "TSA Subagent Redirect",
  description:
    "Intercepta Agent/sessions_spawn tool calls e redireciona subagent legados (ex: pipeline-runner) pra canônicos (0-joker, 0-hero, 0-creator, 0-hunter) via roles-routing.yaml. Hot-reload no arquivo, audit log em redirect-audit.log.",
  register(api) {
    registerSubagentRedirect(api);
  },
});
