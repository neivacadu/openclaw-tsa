/**
 * tsa-local-compactor — SDK adapter (before_prompt_build).
 *
 * Mantém a LÓGICA pura em ./compact.ts (compact + helpers). Aqui só adapta
 * pro contrato do OpenClaw SDK:
 *
 *   api.on("before_prompt_build", (event, ctx) => { prependSystemContext })
 *
 * Estratégia: o SDK do `before_prompt_build` não permite reescrever o array
 * `messages` (o result type só aceita prompt/system context). Então a gente:
 *   1. Roda `shouldCompact(event.messages, cfg)` — heurística len/4+1.
 *   2. Se threshold batido, chama `compact()` pra gerar a mensagem-summary
 *      (mesma lógica antiga, mesmo `<summary>` tag, mesmas extrações).
 *   3. Retorna esse summary como `prependSystemContext` (cacheável).
 *   4. Se off ou abaixo do threshold, retorna undefined (no-op).
 *
 * Config lê de api.pluginConfig com fallback pros defaults documentados.
 *
 * Por design: enabled:false em openclaw.json até validação canary 1 bot.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  compact,
  DEFAULT_CONFIG,
  estimateTokens,
  shouldCompact,
  type CompactConfig,
  type Message,
} from "./compact.js";

function resolveConfig(raw: unknown): CompactConfig {
  const pc = (raw as Partial<CompactConfig> | undefined) ?? {};
  return {
    preserveRecent:
      typeof pc.preserveRecent === "number" && pc.preserveRecent > 0
        ? pc.preserveRecent
        : DEFAULT_CONFIG.preserveRecent,
    maxTokens:
      typeof pc.maxTokens === "number" && pc.maxTokens > 0
        ? pc.maxTokens
        : DEFAULT_CONFIG.maxTokens,
    compactTarget:
      typeof pc.compactTarget === "number" && pc.compactTarget > 0
        ? pc.compactTarget
        : DEFAULT_CONFIG.compactTarget,
    mode:
      pc.mode === "heuristic" || pc.mode === "llm" || pc.mode === "off"
        ? pc.mode
        : DEFAULT_CONFIG.mode,
    logBeforeAfter:
      typeof pc.logBeforeAfter === "boolean" ? pc.logBeforeAfter : DEFAULT_CONFIG.logBeforeAfter,
  };
}

/**
 * SDK messages chegam como `unknown[]`. Aceitamos qualquer shape duck-typed
 * que tenha `role` válido + algum campo de texto. Mensagens estranhas viram
 * placeholders de texto vazio (ainda contam pra estimativa de tokens).
 */
function coerceMessages(raw: unknown[]): Message[] {
  const out: Message[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const role = o.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      continue;
    }
    const m: Message = { role };
    if (typeof o.text === "string") m.text = o.text;
    if (typeof o.toolName === "string") m.toolName = o.toolName;
    if (typeof o.input === "string") m.input = o.input;
    if (typeof o.output === "string") m.output = o.output;
    // Fallback: se não tiver text mas tiver `content` string, joga em text.
    if (!m.text && typeof o.content === "string") m.text = o.content;
    out.push(m);
  }
  return out;
}

export function registerLocalCompactor(api: OpenClawPluginApi): void {
  api.on("before_prompt_build", async (event, _ctx) => {
    try {
      const cfg = resolveConfig(api.pluginConfig);
      if (cfg.mode === "off") return undefined;

      const rawMsgs = Array.isArray(event.messages) ? event.messages : [];
      const msgs = coerceMessages(rawMsgs);
      if (!shouldCompact(msgs, cfg)) return undefined;

      const out = compact(msgs, cfg);
      // compact() retorna [<summary system msg>, ...preserved]. O texto do
      // primeiro item é o que a gente quer injetar como systemContext.
      const head = out[0];
      if (!head || head.role !== "system" || !head.text) return undefined;

      if (cfg.logBeforeAfter) {
        const tIn = msgs.reduce((s, m) => s + estimateTokens(m), 0);
        const tOut = out.reduce((s, m) => s + estimateTokens(m), 0);
        api.logger.info?.(
          `tsa-local-compactor: in=${tIn} msgs=${msgs.length} out=${tOut} msgs=${out.length} saved=${tIn - tOut} mode=${cfg.mode}`,
        );
      }

      return { prependSystemContext: head.text };
    } catch (err) {
      api.logger.warn?.(
        `tsa-local-compactor before_prompt_build failed (fail-open): ${(err as Error).message}`,
      );
      return undefined;
    }
  });
}
