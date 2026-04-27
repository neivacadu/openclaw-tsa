import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerLogBashExecPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-log-bash-exec",
  name: "TSA Log Bash Exec",
  description:
    "Native TS migration of /opt/gold-standard/security-hooks/log-bash-exec.sh (S3). Logs every Bash/shell execution to ~/.openclaw/logs/bash-exec.log with command, exit_code, duration_ms, truncated stdout, and SLO breach tag (>30s). Fire-and-forget, never blocks.",
  register(api) {
    registerLogBashExecPlugin(api);
  },
});
