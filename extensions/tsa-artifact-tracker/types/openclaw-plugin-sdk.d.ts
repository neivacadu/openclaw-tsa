/**
 * Local SDK shim — research/picks-v31 only.
 *
 * In the OpenClaw monorepo, `openclaw/plugin-sdk/plugin-entry` resolves
 * via the `@openclaw/plugin-sdk` workspace package. For standalone
 * builds in this research workspace we don't have the workspace, so we
 * declare the surface area we actually consume (definePluginEntry,
 * OpenClawPluginApi, AnyAgentTool) with minimal-but-faithful types.
 *
 * Production runtime resolves the real module — these types only exist
 * to make `tsc` happy when building the plugin in isolation. The shape
 * matches src/plugin-sdk/plugin-entry.ts at OpenClaw 2026.4.25.
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type PluginLogger = {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };

  export type AnyAgentTool = {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (update: unknown) => void,
    ) => Promise<unknown>;
    ownerOnly?: boolean;
    displaySummary?: string;
  };

  export type OpenClawPluginToolFactory = (ctx: {
    config: unknown;
    sessionKey?: string;
    sandboxed?: boolean;
  }) => AnyAgentTool;

  export type OpenClawPluginToolOptions = {
    names?: string[];
  };

  export type InternalHookHandler = (event: any, ctx: any) => Promise<unknown> | unknown;

  export type OpenClawPluginApi = {
    id: string;
    name: string;
    version?: string;
    description?: string;
    config: unknown;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    on: (event: string, handler: InternalHookHandler) => void;
    registerTool: (
      tool: AnyAgentTool | OpenClawPluginToolFactory,
      opts?: OpenClawPluginToolOptions,
    ) => void;
    registerHook?: (events: string | string[], handler: InternalHookHandler) => void;
  };

  export type OpenClawPluginConfigSchema = unknown;

  export type DefinePluginEntryOptions = {
    id: string;
    name: string;
    description: string;
    kind?: string;
    configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
    register: (api: OpenClawPluginApi) => void;
  };

  export type DefinedPluginEntry = {
    id: string;
    name: string;
    description: string;
    configSchema: OpenClawPluginConfigSchema;
    register: (api: OpenClawPluginApi) => void;
    kind?: string;
  };

  export function definePluginEntry(options: DefinePluginEntryOptions): DefinedPluginEntry;

  export const emptyPluginConfigSchema: OpenClawPluginConfigSchema;
}
