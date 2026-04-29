import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * MVP cascade progress UX (Camada 1 v1.5).
 *
 * Problema: cascade ACE → JOKER → HERO/CREATOR → HUNTER leva 15-30s+ (p99 ~180s).
 * Sem feedback no Telegram, bot fica "mudo" e cliente abandona janela.
 *
 * Solução:
 *  - ACK <3s na primeira deteccao de spawn de subagent
 *  - Progress edit a cada 30s na MESMA mensagem (sem flood)
 *  - Fallback p99=180s: aborta cascade e dispara Camada 2 redirect
 *
 * Hooks usados:
 *  - subagent_spawning: dispara em cada spawn (encadeado), serve pra ACK + progress.
 *  - subagent_yielded:  encerra rastreio quando cascade conclui.
 *
 * Por design: enabled:false em openclaw.json. Agent 9 builda; Agent 10 ativa.
 * Camada 1 ainda em soft-launch — mesmo carregado, hook nao dispara em Camada 2.
 *
 * Compat: API real de api.channels.* pode diferir; chamadas usam optional
 * chaining + .catch(()=>{}) pra nao quebrar runtime se metodo nao existir.
 */

const ACK_TIMEOUT_MS = 3_000;
const PROGRESS_INTERVAL_MS = 30_000;
const FALLBACK_P99_MS = 180_000;

const TEMPLATES = {
  ack: "Recebi a tarefa. Vou trabalhar nela e te aviso assim que tiver.",
  progressGeneric: "Ainda processando — análise complexa precisa de algumas etapas.",
  progressByAgent: {
    "0-joker": "Joker classificando o caso...",
    "0-hero": "Hero executando a tarefa...",
    "0-creator": "Creator desenhando uma análise nova...",
    "0-hunter": "Hunter validando o resultado...",
  } as Record<string, string>,
  fallback:
    "Demorou mais que o esperado. Vou te dar uma resposta direta agora; se quiser análise mais profunda, posso retomar.",
  errorFatal: "Algo deu errado no processamento. Pode reformular ou tentar de novo?",
};

interface CascadeState {
  parentSession: string;
  startedAt: number;
  ackSent: boolean;
  lastProgressAt: number;
  cascadeChain: string[];
}

const activeCascades = new Map<string, CascadeState>();
let logPath = "";

function ensureLogPath(): string {
  if (logPath) return logPath;
  const home = process.env.HOME ?? homedir();
  logPath = process.env.CASCADE_PROGRESS_LOG ?? join(home, ".openclaw/logs/cascade-progress.jsonl");
  mkdirSync(dirname(logPath), { recursive: true });
  return logPath;
}

function appendLog(event: Record<string, unknown>): void {
  try {
    appendFileSync(ensureLogPath(), JSON.stringify({ ts: Date.now(), ...event }) + "\n");
  } catch {
    /* swallow — logging best-effort */
  }
}

function progressTextFor(chain: string[]): string {
  const last = chain[chain.length - 1];
  if (!last) return TEMPLATES.progressGeneric;
  return TEMPLATES.progressByAgent[last] ?? TEMPLATES.progressGeneric;
}

function extractParentSession(ctx: unknown): string {
  const c = ctx as Record<string, unknown> | null | undefined;
  if (!c) return "";
  return (c.parentSessionKey as string | undefined) ?? (c.sessionKey as string | undefined) ?? "";
}

function extractTargetAgent(event: unknown): string {
  const e = event as Record<string, unknown> | null | undefined;
  if (!e) return "?";
  return (e.targetAgentId as string | undefined) ?? (e.agentId as string | undefined) ?? "?";
}

export function registerCascadeProgress(api: OpenClawPluginApi): void {
  const onAny = (
    api as unknown as { on?: (evt: string, cb: (ev: unknown, ctx: unknown) => unknown) => void }
  ).on;
  if (!onAny) {
    appendLog({ event: "register_skip_no_on" });
    return;
  }

  onAny.call(api, "subagent_spawning", (event: unknown, ctx: unknown) => {
    const parentSession = extractParentSession(ctx);
    if (!parentSession) return null;

    let cascade = activeCascades.get(parentSession);
    if (!cascade) {
      cascade = {
        parentSession,
        startedAt: Date.now(),
        ackSent: false,
        lastProgressAt: 0,
        cascadeChain: [],
      };
      activeCascades.set(parentSession, cascade);
    }
    cascade.cascadeChain.push(extractTargetAgent(event));

    const elapsed = Date.now() - cascade.startedAt;
    const channels = (
      api as unknown as { channels?: Record<string, (arg: unknown) => Promise<unknown> | unknown> }
    ).channels;

    // ACK <3s na primeira deteccao
    if (!cascade.ackSent && elapsed < ACK_TIMEOUT_MS) {
      cascade.ackSent = true;
      const send = channels?.sendToOriginalRequester;
      if (typeof send === "function") {
        try {
          const out = send({ sessionKey: parentSession, text: TEMPLATES.ack });
          if (out && typeof (out as Promise<unknown>).catch === "function") {
            (out as Promise<unknown>).catch(() => {});
          }
        } catch {
          /* best-effort */
        }
      }
      appendLog({ event: "ack", parentSession, elapsed });
    }

    // Progress edit a cada 30s
    if (Date.now() - cascade.lastProgressAt > PROGRESS_INTERVAL_MS) {
      cascade.lastProgressAt = Date.now();
      const edit = channels?.editLastMessage;
      if (typeof edit === "function") {
        try {
          const out = edit({
            sessionKey: parentSession,
            text: progressTextFor(cascade.cascadeChain),
          });
          if (out && typeof (out as Promise<unknown>).catch === "function") {
            (out as Promise<unknown>).catch(() => {});
          }
        } catch {
          /* best-effort */
        }
      }
      appendLog({ event: "progress", parentSession, chain: [...cascade.cascadeChain] });
    }

    // Fallback p99
    if (elapsed > FALLBACK_P99_MS) {
      const edit = channels?.editLastMessage;
      if (typeof edit === "function") {
        try {
          const out = edit({ sessionKey: parentSession, text: TEMPLATES.fallback });
          if (out && typeof (out as Promise<unknown>).catch === "function") {
            (out as Promise<unknown>).catch(() => {});
          }
        } catch {
          /* best-effort */
        }
      }
      appendLog({ event: "fallback_p99", parentSession, elapsed });
      activeCascades.delete(parentSession);
      return { abortCascade: true, fallbackTo: "layer2" };
    }

    return null;
  });

  onAny.call(api, "subagent_yielded", (_event: unknown, ctx: unknown) => {
    const parentSession = extractParentSession(ctx);
    if (!parentSession) return null;

    const cascade = activeCascades.get(parentSession);
    if (!cascade) return null;

    activeCascades.delete(parentSession);
    appendLog({
      event: "completed",
      parentSession,
      duration: Date.now() - cascade.startedAt,
      chain: cascade.cascadeChain,
    });
    return null;
  });

  appendLog({ event: "registered", hooks: ["subagent_spawning", "subagent_yielded"] });
}
