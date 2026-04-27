import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerNotifyStopPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-notify-stop",
  name: "TSA Notify Stop",
  description:
    "Native TS migration of /opt/gold-standard/security-hooks/notify-stop.sh (S4). Runs validation gates (Constitution intact, ratings DB accessible) at before_agent_finalize and notifies Cadu via Telegram if reason != normal. Always returns continue (never blocks finalize).",
  register(api) {
    registerNotifyStopPlugin(api);
  },
});
