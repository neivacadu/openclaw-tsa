/**
 * tsa-context-preload — SDK entry (Pick P0-A, Ace-TSIA v3.1).
 *
 * Public surface:
 *   - default export: definePluginEntry result (consumed by the fork loader
 *     via package.json `openclaw.extensions: ["./dist/index.js"]`)
 *   - named re-exports: keep the same identifiers exposed by 0.1.0 so the
 *     vitest smoke harness (and any external importer) keeps working
 *     unchanged after the refactor.
 *
 * Logic lives in ./plugin.ts. This file only wires the SDK shape.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerContextPreload } from "./plugin.js";

export default definePluginEntry({
  id: "tsa-context-preload",
  name: "TSA Context Preload",
  description:
    "Injects workspace memory MDs (last 3d) + recent artifacts (last 24h) + tail of previous session into the system prompt at before_prompt_build. Heuristic mtime-based recall. Pick P0-A — band-aid until Camada 4 (pgvector / P2-E). Disabled by default.",
  register(api) {
    registerContextPreload(api);
  },
});

// Re-exports — keep 0.1.0 import surface for tests + downstream consumers.
export {
  ContextPreload,
  createContextPreload,
  registerContextPreload,
  createBeforePromptBuildHandler,
  resolveConfig,
  loadRecentMemories,
  findRecentArtifacts,
  loadLastSessionTail,
  buildBlock,
  estimateTokens,
  getMetrics,
  DEFAULT_CONFIG,
} from "./plugin.js";

export type { ContextPreloadConfig, HookContext, HookResult, PreloadMetrics } from "./plugin.js";

export type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
