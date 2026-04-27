import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerLogEditIntentPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-log-edit-intent",
  name: "TSA Log Edit/Write Intent",
  description:
    "Native TS migration of /opt/gold-standard/security-hooks/log-edit-intent.sh (S2). Logs every Edit/Write/MultiEdit attempt to ~/.openclaw/logs/edit-intent.log with structured fields (tool, op, path, size). Never blocks. Replaces the bash spawn for this hook; .sh stays as backup.",
  register(api) {
    registerLogEditIntentPlugin(api);
  },
});
