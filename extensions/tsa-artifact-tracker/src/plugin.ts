/**
 * tsa-artifact-tracker — registration module.
 *
 * Wires up:
 *  - after_tool_call hook    : extracts artifacts from Write/Edit/Bash
 *                              tool results and persists them.
 *  - artifacts_search        : FTS5 search.
 *  - artifacts_recent        : last-N-hours window.
 *  - artifacts_get_by_path   : single fetch by absolute path.
 *  - artifacts_update_status : active|archived|deleted.
 *
 * Library logic lives in ./index.ts (ArtifactTracker class, parsers,
 * heuristics, schema). This file only owns plugin wiring.
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { ArtifactTracker, type ArtifactStatus, type TrackerConfig } from "./index";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _singleton: ArtifactTracker | null = null;

function tracker(cfg?: Partial<TrackerConfig>): ArtifactTracker {
  if (!_singleton) _singleton = new ArtifactTracker(cfg);
  return _singleton;
}

/** Resets the cached tracker (used by smoke tests / hot reload). */
export function _resetTrackerForTests(): void {
  if (_singleton) {
    try {
      _singleton.close();
    } catch {
      /* noop */
    }
  }
  _singleton = null;
}

// ---------------------------------------------------------------------------
// Tool factories
//
// We follow the shape used by tavily / memory-core: a plain object with
// { name, description, parameters, execute }. The `parameters` field uses a
// JSON Schema-shaped object — the SDK accepts plain JSON Schema for
// hand-rolled tools (no typebox dependency required for MVP).
// ---------------------------------------------------------------------------

function jsonResult(value: unknown) {
  return {
    output: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function makeArtifactsSearchTool(): AnyAgentTool {
  return {
    name: "artifacts_search",
    label: "Search Artifacts",
    description:
      "Full-text search over tracked artifacts (path, filename, prompt_summary, tags). Filter by kind, returns most recent first.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "FTS5 query (e.g. 'aula vendas')" },
        kind: {
          type: "string",
          enum: ["html", "pdf", "doc", "md", "image", "video", "audio", "data", "code", "other"],
        },
        limit: { type: "integer", default: 10, minimum: 1, maximum: 100 },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = (params ?? {}) as {
        query: string;
        kind?: string;
        limit?: number;
      };
      const rows = tracker().searchByQuery(args.query, args.kind, args.limit ?? 10);
      return jsonResult(rows);
    },
  } as unknown as AnyAgentTool;
}

function makeArtifactsRecentTool(): AnyAgentTool {
  return {
    name: "artifacts_recent",
    label: "Recent Artifacts",
    description:
      "List artifacts created in the last N hours, ordered by created_at desc. Default 24h, limit 20.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        hours_back: { type: "integer", default: 24, minimum: 1, maximum: 8760 },
        limit: { type: "integer", default: 20, minimum: 1, maximum: 200 },
      },
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = (params ?? {}) as { hours_back?: number; limit?: number };
      const rows = tracker().recent(args.hours_back ?? 24, args.limit ?? 20);
      return jsonResult(rows);
    },
  } as unknown as AnyAgentTool;
}

function makeArtifactsGetByPathTool(): AnyAgentTool {
  return {
    name: "artifacts_get_by_path",
    label: "Get Artifact By Path",
    description: "Fetch a single artifact by its absolute filesystem path.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = (params ?? {}) as { path: string };
      return jsonResult(tracker().getByPath(args.path));
    },
  } as unknown as AnyAgentTool;
}

function makeArtifactsUpdateStatusTool(): AnyAgentTool {
  return {
    name: "artifacts_update_status",
    label: "Update Artifact Status",
    description:
      "Mark an artifact as active|archived|deleted. Use 'archived' when user asks to update/replace a published page.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        status: { type: "string", enum: ["active", "archived", "deleted"] },
      },
      required: ["path", "status"],
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const args = (params ?? {}) as { path: string; status: ArtifactStatus };
      const ok = tracker().updateStatus(args.path, args.status);
      return jsonResult({ ok });
    },
  } as unknown as AnyAgentTool;
}

// ---------------------------------------------------------------------------
// Hook handler
// ---------------------------------------------------------------------------

const TRACKED_TOOLS_DEFAULT = new Set(["Write", "Edit", "Bash"]);

function shouldTrack(toolName: string, configured?: string[]): boolean {
  if (configured && configured.length > 0) return configured.includes(toolName);
  return TRACKED_TOOLS_DEFAULT.has(toolName);
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

export function registerArtifactTracker(api: OpenClawPluginApi): void {
  // pluginConfig is the validated block from openclaw.json. May be missing on
  // first boot — defaults inside ArtifactTracker handle that case.
  const pluginCfg = (api.pluginConfig ?? {}) as Partial<TrackerConfig>;

  // Eagerly construct the singleton so DB schema is applied at register-time
  // rather than on first hook invocation. This keeps the first Write/Bash
  // call from paying schema-init latency.
  try {
    tracker(pluginCfg);
  } catch (err) {
    api.logger.error?.(
      `tsa-artifact-tracker init failed: ${(err as Error).message}; will retry on first hook fire`,
    );
  }

  // Register the 4 read/write tools. AnyAgentTool here uses the plain
  // JSON Schema shape — production SDK accepts both typebox and JSON
  // Schema parameter blocks.
  api.registerTool(makeArtifactsSearchTool());
  api.registerTool(makeArtifactsRecentTool());
  api.registerTool(makeArtifactsGetByPathTool());
  api.registerTool(makeArtifactsUpdateStatusTool());

  // after_tool_call hook — fail-open. Hooks must never throw into the tool
  // path; on any exception we log and let the agent proceed.
  api.on("after_tool_call", async (event, ctx) => {
    try {
      const toolName = (event as { toolName?: string }).toolName ?? "";
      if (!shouldTrack(toolName, pluginCfg.trackedTools)) return undefined;

      const params = ((event as { params?: unknown }).params ?? {}) as Record<string, unknown>;
      const result = (event as { result?: unknown }).result;

      tracker(pluginCfg).track(toolName, params, result, {
        agent: ctx?.agentId ?? undefined,
        sessionId: ctx?.sessionKey ?? ctx?.sessionId ?? undefined,
        promptSummary: undefined,
      });
    } catch (err) {
      api.logger.error?.(`tsa-artifact-tracker after_tool_call failed: ${(err as Error).message}`);
    }
    return undefined;
  });
}
