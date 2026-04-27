import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSteerBusyMode } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-steer-busy-mode",
  name: "TSA Steer Busy Mode",
  description:
    "ADAPT of Hermes /steer busy_input_mode (PR #16279, commit 635253b9). Routes Telegram /steer commands and (optionally) plain inputs received while the agent is busy through OpenClaw's existing steerControlledSubagentRun, providing real-time correction without resetting the session. Falls back gracefully to the default queue when no active run is detected.",
  register(api) {
    registerSteerBusyMode(api);
  },
});
