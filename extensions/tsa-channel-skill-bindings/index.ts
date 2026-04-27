import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerChannelSkillBindingsPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-channel-skill-bindings",
  name: "TSA Channel -> Skill Bindings",
  description:
    "Maps an inbound channel (telegram chat id, discord guild/channel id, etc.) to a list of auto-skills and injects them as system context for the agent. Port of Hermes commit 8fb861ea (Slack-only) generalized to telegram + discord. Reads from openclaw.json: channels.<provider>.skill_bindings: [{id,skills}].",
  register(api) {
    registerChannelSkillBindingsPlugin(api);
  },
});
