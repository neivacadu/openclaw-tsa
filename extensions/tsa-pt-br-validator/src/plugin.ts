import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_VALIDATOR_CONFIG,
  extractText,
  isTextProducingTool,
  validateText,
  type ValidatorConfig,
} from "./validator.js";

/**
 * Plugin SDK wrapper para tsa-pt-br-validator.
 *
 * Registra hook `after_tool_call`. Filtra tools que produzem texto
 * (Write/Edit/Bash heredoc/WebFetch save). Em monitorOnly:true (default)
 * apenas loga JSONL e segue (allow). Em monitorOnly:false (enforcement)
 * retorna { status: "error" } com a sugestao.
 *
 * Defaults seguros:
 *   - enabled: false (configurado no openclaw.json do clone)
 *   - monitorOnly: true (warning + metrica, nao bloqueia)
 */

interface PluginConfig {
  enabled: boolean;
  monitorOnly: boolean;
  scoreThreshold: number;
  minTextLength: number;
  watchedWordsPath: string;
  anglicismsPath: string;
  logPath: string;
}

const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  enabled: false,
  ...DEFAULT_VALIDATOR_CONFIG,
};

function readConfig(api: OpenClawPluginApi): PluginConfig {
  // Best-effort: SDK expoe config via api.config (forma varia por versao).
  // Fallback pros defaults se nao acharmos nada.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = ((api as any).config ?? {}) as Partial<PluginConfig>;
  return { ...DEFAULT_PLUGIN_CONFIG, ...raw };
}

function appendJsonl(logPath: string, payload: Record<string, unknown>): void {
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch {
    /* noop — fail-open on log IO */
  }
}

export function registerPtBrValidatorPlugin(api: OpenClawPluginApi): void {
  const cfg = readConfig(api);

  if (!cfg.enabled) {
    api.logger?.info?.(`tsa-pt-br-validator carregado mas enabled=false — hook nao dispara`);
    return;
  }

  const validatorCfg: ValidatorConfig = {
    monitorOnly: cfg.monitorOnly,
    scoreThreshold: cfg.scoreThreshold,
    minTextLength: cfg.minTextLength,
    watchedWordsPath: cfg.watchedWordsPath,
    anglicismsPath: cfg.anglicismsPath,
    logPath: cfg.logPath,
  };

  api.on("after_tool_call", async (event, ctx) => {
    try {
      const toolName = event.toolName ?? "";
      if (!isTextProducingTool(toolName)) return undefined;

      const params = (event.params ?? {}) as Record<string, unknown>;
      const text = extractText(toolName, params, event.result);

      const result = validateText(text, validatorCfg);

      if (result.decision === "allow" && result.score === undefined) {
        // texto curto / nao pt-BR — sem evento
        return undefined;
      }

      const agentId =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ctx as any)?.agentId ?? (ctx as any)?.requesterSessionKey ?? "unknown";

      const eventBase = {
        agent: agentId,
        tool: toolName,
        score: result.score,
        issue_count: result.issues?.length ?? 0,
        issues: (result.issues ?? []).slice(0, 10),
        mode: cfg.monitorOnly ? "monitor" : "enforcement",
      };

      if (result.decision === "allow") {
        appendJsonl(cfg.logPath, { ...eventBase, decision: "allow" });
        return undefined;
      }

      if (result.decision === "allow_warn") {
        appendJsonl(cfg.logPath, { ...eventBase, decision: "allow_warn" });
        api.logger?.warn?.(
          `tsa-pt-br-validator monitor warn agent=${agentId} tool=${toolName} score=${result.score}`,
        );
        return undefined;
      }

      // deny (enforcement)
      appendJsonl(cfg.logPath, { ...eventBase, decision: "deny" });
      api.logger?.warn?.(
        `tsa-pt-br-validator deny agent=${agentId} tool=${toolName} score=${result.score}`,
      );
      const errorMsg =
        (result.reason ?? "pt-BR score abaixo do limite") +
        (result.suggestion ? `\n\nSugestoes:\n${result.suggestion}` : "");
      return {
        status: "error" as const,
        error: errorMsg,
      };
    } catch (err) {
      api.logger?.warn?.(
        `tsa-pt-br-validator failed tool=${event.toolName}: ${(err as Error).message}`,
      );
      return undefined;
    }
  });
}
