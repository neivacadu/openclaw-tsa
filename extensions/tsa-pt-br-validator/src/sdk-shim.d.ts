/**
 * Local shim de tipos pro build standalone (fora do monorepo openclaw-tsa).
 *
 * No monorepo, `openclaw/plugin-sdk/plugin-entry` eh resolvido via workspace
 * dep `@openclaw/plugin-sdk` e esses tipos vem do dist real do SDK. Aqui no
 * picks-v31 ainda nao temos o workspace, entao stubamos o minimo necessario
 * pra `tsc -p .` e `node --test` funcionarem.
 *
 * Quando o plugin for puxado pro monorepo (`/opt/openclaw-tsa-git/extensions/`)
 * esse shim eh ignorado — os tipos reais ganham prioridade via node_modules.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export interface PluginLogger {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  }

  export interface AfterToolCallEvent {
    toolName: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: string;
    durationMs?: number;
  }

  export interface AfterToolCallContext {
    agentId?: string;
    requesterSessionKey?: string;
    childSessionKey?: string;
  }

  export type AfterToolCallHookResult = undefined | void | { status: "error"; error: string };

  export interface OpenClawPluginApi {
    logger?: PluginLogger;
    config?: Record<string, unknown>;
    on(
      event: "after_tool_call",
      handler: (
        event: AfterToolCallEvent,
        ctx: AfterToolCallContext,
      ) => Promise<AfterToolCallHookResult> | AfterToolCallHookResult,
    ): void;
    on(event: string, handler: (...args: unknown[]) => unknown): void;
  }

  export interface DefinedPluginEntry {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  }

  export interface DefinePluginEntryOptions {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  }

  export function definePluginEntry(opts: DefinePluginEntryOptions): DefinedPluginEntry;
}
