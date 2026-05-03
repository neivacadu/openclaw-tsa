/**
 * tsa-artifact-tracker (P1-D) — SDK entry point.
 *
 * Mirrors padrão canônico dos peers da Onda SDK
 * (tsa-skills-rank, tsa-budget-gate, tsa-bmad-router).
 * Library logic em src/index.ts (ArtifactTracker class).
 * Plugin wiring em src/plugin.ts (registerArtifactTracker).
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerArtifactTracker } from "./src/plugin";

export default definePluginEntry({
  id: "tsa-artifact-tracker",
  name: "TSA Artifact Tracker",
  description:
    "Plugin P1-D: rastreador de artefatos gerados pelos agentes durante execução de tarefas. Hook after_tool_call extrai artefatos de Write/Edit/Bash e persiste via SQLite com FTS5. Tools: artifacts_search, artifacts_recent, artifacts_get_by_path, artifacts_update_status. Ships disabled by default.",
  register(api) {
    registerArtifactTracker(api);
  },
});
