import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerMultiPersonaPrompt } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-multi-persona-prompt",
  name: "TSA Multi-Persona Prompt",
  description:
    "Injeta protocolo dos 5 chapéus (turbo.md) no system prompt do agente alvo (ex: 0-ace) via hook before_prompt_build. Hot-reload via mtime check, fail-silent se arquivo ausente.",
  register(api) {
    registerMultiPersonaPrompt(api);
  },
});
