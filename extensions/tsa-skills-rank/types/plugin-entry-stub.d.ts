/**
 * Local stub for `openclaw/plugin-sdk/plugin-entry` so tsa-skills-rank
 * builds standalone in this research repo (research/picks-v31).
 *
 * In production (`/opt/openclaw-tsa-git/extensions/tsa-skills-rank`), the
 * real types resolve via `tsconfig.package-boundary.paths.json` at the
 * monorepo root — `openclaw/plugin-sdk/*` -> `../dist/plugin-sdk/...`.
 *
 * Surface kept minimal: only what `definePluginEntry`, `api.on(...)` and
 * `api.registerTool(...)` actually need for this plugin. Mirrors the shape
 * used by sibling plugin tsa-bmad-router/types/plugin-entry-stub.d.ts and
 * the canonical reference at /opt/openclaw-tsa-git/src/plugins/types.ts
 * (OpenClawPluginApi).
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  /** Structured logger surface — same shape as cascade-monitor uses. */
  export interface PluginLogger {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
    debug?: (msg: string, meta?: unknown) => void;
  }

  /** before_prompt_build hook event. */
  export interface PluginHookBeforePromptBuildEvent {
    prompt: string;
    /** Session messages prepared for this run. Shape is provider-neutral. */
    messages: Array<{ role: string; content: string } | unknown>;
  }

  /** before_prompt_build hook return. Plugins prefer appendSystemContext. */
  export interface PluginHookBeforePromptBuildResult {
    systemPrompt?: string;
    prependContext?: string;
    prependSystemContext?: string;
    appendSystemContext?: string;
  }

  /** after_tool_call hook event. */
  export interface PluginHookAfterToolCallEvent {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
  }

  /** Agent context shared by hooks. */
  export interface PluginHookAgentContext {
    agentId?: string;
    sessionKey?: string;
    runId?: string;
  }

  /** Tool registration shape (subset of AnyAgentTool). */
  export interface PluginToolRegistration {
    name: string;
    label?: string;
    description: string;
    /** JSON Schema or TypeBox schema for tool params. */
    parameters: unknown;
    execute: (
      toolCallId: string,
      rawParams: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>;
  }

  /** Plugin runtime API injected by definePluginEntry. */
  export interface OpenClawPluginApi {
    id: string;
    name: string;
    description?: string;
    logger: PluginLogger;
    /** Plugin-scoped config from openclaw.json `config:` block. */
    pluginConfig?: Record<string, unknown>;

    /**
     * Subscribe to a hook by name. Return shape depends on hook contract.
     *  - `before_prompt_build`: return { appendSystemContext } etc.
     *  - `after_tool_call`: return void.
     */
    on<TEvent = unknown, TCtx = unknown, TResult = unknown>(
      hookName: string,
      handler: (event: TEvent, ctx: TCtx) => TResult | Promise<TResult>,
    ): void;

    /** Alias for on() — kept for parity with the canonical SDK surface. */
    registerHook<TEvent = unknown, TCtx = unknown, TResult = unknown>(
      events: string | string[],
      handler: (event: TEvent, ctx: TCtx) => TResult | Promise<TResult>,
    ): void;

    /** Register a custom tool callable by the agent. */
    registerTool(tool: PluginToolRegistration): void;
  }

  export interface PluginEntryDefinition {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void | Promise<void>;
  }

  export function definePluginEntry(def: PluginEntryDefinition): PluginEntryDefinition;
}
