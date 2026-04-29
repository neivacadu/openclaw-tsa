/**
 * tsa-skills-rank — canonical SDK entry.
 *
 * Mirrors the OpenClaw plugin shape used in production extensions
 * (tsa-cascade-monitor, tsa-log-bash-exec, tsa-bmad-router): the
 * top-level `index.ts` only wires `definePluginEntry({...})`; all logic
 * lives in `src/plugin.ts` (registerSkillsRanker) + `src/skills-ranker.ts`
 * (the SkillsRanker class with FTS5 ranking, schema bootstrap, invocation
 * tracking, and snapshot builder).
 *
 * The SDK is consumed via the package boundary import
 * `openclaw/plugin-sdk/plugin-entry`. At runtime in production it resolves
 * to the monorepo's `packages/plugin-sdk` workspace export. For standalone
 * builds in research/picks-v31 we ship a local type shim under
 * `types/plugin-entry-stub.d.ts` so `tsc` can compile without the workspace.
 *
 * Hooks registered: before_prompt_build, after_tool_call.
 * Tools registered: skill_search.
 *
 * Pick P0-B of Ace-TSIA v3.1. Ships disabled by default (openclaw.json
 * enabled:false). Cadu confirmou: NAO cortar skills.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSkillsRanker } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-skills-rank",
  name: "TSA Skills Rank",
  description:
    "Banco SQLite local mantem TODAS as 1.424 skills. Hook before_prompt_build injeta top N (default 50) rankeadas por FTS5 + uso recente + success rate + categoria no system prompt via appendSystemContext (cacheable). Hook after_tool_call atualiza use_count/success_rate quando skill_invoke roda. Tool skill_search expoe o banco completo sob demanda. V2 troca FTS5 por pgvector quando Camada 4 subir. Pick P0-B Ace-TSIA v3.1.",
  register(api) {
    registerSkillsRanker(api);
  },
});
