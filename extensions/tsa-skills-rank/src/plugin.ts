/**
 * tsa-skills-rank — SDK wiring (registerSkillsRanker).
 *
 * This module is the canonical SDK plugin entry. It is invoked by the
 * top-level `index.ts` via `definePluginEntry({ register })` and connects
 * the SkillsRanker logic to OpenClaw's hook + tool surface:
 *
 *  - api.on("before_prompt_build", ...) — ranks the top N skills (default 50)
 *    against the latest user message and returns { appendSystemContext }.
 *    Using appendSystemContext keeps the snapshot in the cacheable system
 *    prompt segment so providers can hit prompt cache.
 *
 *  - api.on("after_tool_call", ...) — when the agent fires `skill_invoke`,
 *    bumps use_count + success_rate so the next rank() reflects real usage.
 *
 *  - api.registerTool({ name: "skill_search" }) — exposes the full SQLite
 *    bank to the agent on demand. Skills outside the top N stay reachable
 *    via this tool (Cadu confirmou: NAO cortar skills).
 *
 * Singleton lifecycle: the SkillsRanker is lazy-created on first hook /
 * tool call, sharing one DB handle across hooks within the process.
 */

import type {
  OpenClawPluginApi,
  PluginHookAfterToolCallEvent,
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_CONFIG, pushMetrics, SkillsRanker, type RankerConfig } from "./skills-ranker.js";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _ranker: SkillsRanker | null = null;

function resolveConfig(api: OpenClawPluginApi): Partial<RankerConfig> {
  const raw = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const out: Partial<RankerConfig> = {};
  const numKeys: Array<keyof RankerConfig> = [
    "topN",
    "fts5Weight",
    "useRecencyWeight",
    "successRateWeight",
    "categoryMatchWeight",
    "recencyWindowDays",
  ];
  for (const k of numKeys) {
    const v = raw[k as string];
    if (typeof v === "number" && Number.isFinite(v)) {
      (out[k] as number) = v;
    }
  }
  const strKeys: Array<keyof RankerConfig> = [
    "skillsDir",
    "dbPath",
    "snapshotKey",
    "metricsPushgateway",
  ];
  for (const k of strKeys) {
    const v = raw[k as string];
    if (typeof v === "string" && v.length > 0) {
      (out[k] as string) = v;
    }
  }
  return out;
}

function getRanker(api: OpenClawPluginApi): SkillsRanker {
  if (!_ranker) {
    _ranker = new SkillsRanker(resolveConfig(api));
  }
  return _ranker;
}

// ---------------------------------------------------------------------------
// JSON Schema for the skill_search tool. Kept inline (not a TypeBox import)
// so the standalone build does not pick up extra deps.
// ---------------------------------------------------------------------------

const SKILL_SEARCH_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "Texto livre pra match em FTS5 (nome, descricao, keywords).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      default: 10,
      description: "Quantos resultados retornar. Default 10, cap 50.",
    },
  },
  required: ["query"],
} as const;

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

/**
 * Wires SkillsRanker into the OpenClaw plugin runtime. Called once by the
 * top-level definePluginEntry({register}) shell.
 */
export function registerSkillsRanker(api: OpenClawPluginApi): void {
  // ---- Hook: before_prompt_build (inject top-N snapshot) -------------------
  api.on<
    PluginHookBeforePromptBuildEvent,
    PluginHookAgentContext,
    PluginHookBeforePromptBuildResult | void
  >("before_prompt_build", async (event, _ctx) => {
    let ranker: SkillsRanker;
    try {
      ranker = getRanker(api);
    } catch (err) {
      api.logger?.error?.(
        `tsa-skills-rank ranker init failed: ${(err as Error).message}; failing open`,
      );
      return undefined;
    }

    const topN = ranker.config.topN ?? DEFAULT_CONFIG.topN;

    // Prefer the explicit prompt field; fall back to last user message in
    // the prepared session messages (legacy shape preserved).
    let query = (event?.prompt ?? "").trim();
    if (!query && Array.isArray(event?.messages)) {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const m = event.messages[i] as { role?: string; content?: unknown };
        if (m && m.role === "user" && typeof m.content === "string") {
          query = m.content;
          break;
        }
      }
    }

    let snapshot = "";
    try {
      const top = ranker.rank(query, topN);
      snapshot = ranker.buildSnapshot(top);
    } catch (err) {
      api.logger?.warn?.(
        `tsa-skills-rank rank() failed: ${(err as Error).message}; skipping snapshot`,
      );
    }

    // best-effort metrics push
    void pushMetrics(ranker.config as RankerConfig);

    if (!snapshot) return undefined;

    // Use appendSystemContext so providers can prompt-cache the segment.
    return { appendSystemContext: snapshot };
  });

  // ---- Hook: after_tool_call (bump use_count + success_rate) ---------------
  api.on<PluginHookAfterToolCallEvent, PluginHookAgentContext, void>(
    "after_tool_call",
    async (event, ctx) => {
      if (event?.toolName !== "skill_invoke") return;

      let ranker: SkillsRanker;
      try {
        ranker = getRanker(api);
      } catch (err) {
        api.logger?.error?.(
          `tsa-skills-rank ranker init failed in after_tool_call: ${(err as Error).message}`,
        );
        return;
      }

      const params = (event.params ?? {}) as Record<string, unknown>;
      const skillId = String(params.skill_id ?? params.skillId ?? "").trim();
      if (!skillId) return;

      // Default to "ok"; downgrade to "error" if event.error is set, or if
      // the result payload carries an explicit ok:false flag.
      let result: "ok" | "error" = "ok";
      if (event.error) {
        result = "error";
      } else if (event.result && typeof event.result === "object") {
        const r = event.result as Record<string, unknown>;
        if (r.ok === false) result = "error";
      }

      const sessionId = ctx?.sessionKey ?? null;
      try {
        ranker.recordInvocation(skillId, sessionId, null, result);
      } catch (err) {
        api.logger?.warn?.(
          `tsa-skills-rank recordInvocation failed skill=${skillId}: ${(err as Error).message}`,
        );
      }

      void pushMetrics(ranker.config as RankerConfig);
    },
  );

  // ---- Tool: skill_search --------------------------------------------------
  api.registerTool({
    name: "skill_search",
    label: "Skill Search",
    description:
      "Busca skills no banco completo (1.424 skills) alem das top 50 do rank. Retorna nome, descricao e hint de invocacao.",
    parameters: SKILL_SEARCH_PARAMS,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const ranker = getRanker(api);
      const query = String(rawParams.query ?? "").trim();
      if (!query) {
        return {
          ok: false,
          error: "skill_search: 'query' e obrigatorio",
          skills: [],
        };
      }
      const limitRaw = rawParams.limit;
      const limit =
        typeof limitRaw === "number" && Number.isFinite(limitRaw)
          ? Math.min(50, Math.max(1, Math.floor(limitRaw)))
          : 10;

      try {
        const results = ranker.search(query, limit);
        return {
          ok: true,
          skills: results.map((s) => ({
            skill_id: s.skill_id,
            name: s.skill_name,
            description: s.description ?? "",
            category: s.category ?? null,
            invocation_hint: `skill_invoke({ skill_id: "${s.skill_id}" })`,
          })),
        };
      } catch (err) {
        api.logger?.warn?.(`tsa-skills-rank skill_search failed: ${(err as Error).message}`);
        return {
          ok: false,
          error: (err as Error).message,
          skills: [],
        };
      }
    },
  });
}

// Re-export logic surface so existing consumers (smoke test, scripts/index-skills.sh
// via tsx import) keep working without touching their import paths in muscle memory.
export { SkillsRanker, DEFAULT_CONFIG } from "./skills-ranker.js";
export type { RankerConfig, RankedSkill, SkillRow } from "./skills-ranker.js";
