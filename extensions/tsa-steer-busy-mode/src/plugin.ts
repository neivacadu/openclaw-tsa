import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const LOG_PATH = path.join(os.homedir(), ".openclaw", "logs", "tsa-steer-busy-mode.log");

type SteerOutcome =
  | { ok: true; mode: "steer"; runId?: string; label?: string }
  | { ok: false; fallback: "queue"; reason: string };

/**
 * TSA ADAPT of Hermes /steer busy_input_mode (PR #16279, commit 635253b9).
 *
 * Hermes pattern:
 *   - User sends input while agent is busy executing a tool.
 *   - Instead of queuing or interrupting, the input is injected into the
 *     agent state and delivered after the *next* tool call completes.
 *   - If the agent runtime does not expose a steer() primitive, fall back
 *     to the default queue behaviour (degrade-safe).
 *
 * OpenClaw 4.24+ already ships:
 *   - A queue subsystem with mode "steer" (src/config/types.queue.ts).
 *   - steerControlledSubagentRun() for SUBAGENT runs (src/agents/subagent-control.ts).
 *   - The /subagents steer <id> <message> CLI command.
 *
 * What it does NOT have (gap relative to Hermes):
 *   - A top-level /steer command that reaches the active *root* agent run
 *     during a Telegram conversation. The Hermes hook user_input_during_run
 *     does not exist as a PluginHookName in this fork.
 *
 * This plugin is the ADAPT layer:
 *   1. Registers a /steer slash command that resolves the active subagent
 *      run for the caller's session and forwards to steerControlledSubagentRun.
 *      (This is the closest in-tree primitive — covers the Telegram UX
 *      where the controlling agent is steering a child run.)
 *   2. Hooks message_received so that, when configured, plain inbound text
 *      received while a child run is active is auto-routed to steer instead
 *      of queue. Fallback to queue when no active run exists.
 *
 * TODOs (need core changes, not pluggable yet):
 *   - Top-level (root) agent steer: requires a hook like user_input_during_run
 *     plus an agent.steer(text) seam exposed on the agent runtime. Not
 *     present in PLUGIN_HOOK_NAMES (src/plugins/hook-types.ts) as of
 *     2026.4.25. File a follow-up to add the hook + a SteerableAgent
 *     interface to PluginRuntime.
 *   - Once the hook exists, replace the message_received fallback path with
 *     a true mid-run injection that lands after the current tool call,
 *     matching Hermes semantics exactly.
 */
export function registerSteerBusyMode(api: OpenClawPluginApi): void {
  const cfg = (api.pluginConfig ?? {}) as {
    enabled?: boolean;
    commandName?: string;
    detectInlineSteer?: boolean;
  };

  if (cfg.enabled === false) {
    api.logger?.info?.("tsa-steer-busy-mode disabled by config");
    return;
  }

  const commandName = (cfg.commandName ?? "steer").replace(/^\/+/, "");

  // 1. Slash command: /steer <message>
  //
  // Surface: bypasses the LLM. We attempt steer; if no eligible run is
  // active we tell the user to send the message normally (which will go
  // through the configured queue mode).
  api.registerCommand({
    name: commandName,
    description:
      "Steer the active run (busy mode): inject a correction that lands after the current tool call. Falls back to queue if no active run.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const message = (ctx.args ?? "").trim();
      if (!message) {
        return { text: `Usage: /${commandName} <message>` } as never;
      }
      const outcome = await trySteer(api, {
        sessionKey: ctx.sessionKey,
        message,
        source: "command",
      });
      if (outcome.ok) {
        appendLog(
          `STEER ok mode=${outcome.mode} runId=${outcome.runId ?? "-"} sessionKey=${ctx.sessionKey ?? "-"}`,
        );
        return {
          text: `steered${outcome.label ? ` ${outcome.label}` : ""}: message will land after the next tool call.`,
        } as never;
      }
      appendLog(
        `STEER fallback=${outcome.fallback} reason=${outcome.reason} sessionKey=${ctx.sessionKey ?? "-"}`,
      );
      return {
        text: `no active run to steer (${outcome.reason}). Send the message normally — it will go through the configured queue mode.`,
      } as never;
    },
  });

  // 2. Optional inline detection on message_received.
  //
  // When detectInlineSteer = true, every inbound message that arrives while
  // the run is active gets auto-routed through steer. When false (default),
  // we only log the busy-input event so operators can later decide whether
  // to enable auto-routing.
  if (cfg.detectInlineSteer) {
    api.on("message_received", async (event, mctx) => {
      try {
        const sessionKey = event.sessionKey ?? mctx?.sessionKey;
        const text = (event.content ?? "").trim();
        if (!sessionKey || !text || text.startsWith("/")) {
          return;
        }
        const outcome = await trySteer(api, {
          sessionKey,
          message: text,
          source: "inline",
        });
        if (outcome.ok) {
          appendLog(`INLINE_STEER ok runId=${outcome.runId ?? "-"} sessionKey=${sessionKey}`);
        } else {
          appendLog(`INLINE_STEER passthrough reason=${outcome.reason} sessionKey=${sessionKey}`);
        }
      } catch (err) {
        // message_received must never block delivery
        api.logger?.warn?.(`tsa-steer-busy-mode message_received error: ${String(err)}`);
      }
    });
  } else {
    // Diagnostic-only: log when input is received during a known active run,
    // so we can later tune detectInlineSteer per-channel.
    api.on("message_received", async (event, mctx) => {
      try {
        const sessionKey = event.sessionKey ?? mctx?.sessionKey;
        if (!sessionKey) return;
        const status = await probeActiveRun(sessionKey);
        if (status.active) {
          appendLog(
            `BUSY_INPUT_OBSERVED sessionKey=${sessionKey} runId=${status.runId ?? "-"} content_chars=${(event.content ?? "").length}`,
          );
        }
      } catch {
        // never fail message delivery
      }
    });
  }

  api.logger?.info?.(
    `tsa-steer-busy-mode registered (command=/${commandName}, detectInlineSteer=${cfg.detectInlineSteer === true})`,
  );
}

/**
 * Attempt to steer the active run for sessionKey.
 *
 * Implementation note: we deliberately import OpenClaw internals lazily so
 * the plugin loads even on older runtimes that don't expose them — when the
 * imports fail we fall back to queue mode and surface a clear reason.
 */
async function trySteer(
  api: OpenClawPluginApi,
  args: { sessionKey?: string; message: string; source: "command" | "inline" },
): Promise<SteerOutcome> {
  if (!args.sessionKey) {
    return { ok: false, fallback: "queue", reason: "no_session_key" };
  }

  // Lazy import — keeps the plugin importable even when subagent-control
  // module shape changes between OpenClaw versions.
  let registry: typeof import("../../../src/agents/subagent-registry-read.js") | null = null;
  let control: typeof import("../../../src/agents/subagent-control.js") | null = null;
  try {
    registry = await import("../../../src/agents/subagent-registry-read.js");
    control = await import("../../../src/agents/subagent-control.js");
  } catch (err) {
    return {
      ok: false,
      fallback: "queue",
      reason: `runtime_unavailable:${(err as Error).message ?? "import_failed"}`,
    };
  }

  const entry = registry.getLatestSubagentRunByChildSessionKey(args.sessionKey);
  if (!entry) {
    return { ok: false, fallback: "queue", reason: "no_active_run" };
  }
  if (entry.endedAt) {
    return { ok: false, fallback: "queue", reason: "run_already_finished" };
  }

  // TODO: a real top-level steer needs the controller resolved from the
  // *parent* agent context. We don't have a clean handle to OpenClawConfig
  // or the caller controller from inside a plugin command yet. Until the
  // SDK exposes runtime.resolveControllerForSession(), we report a clear
  // reason and let the queue fallback take over.
  const cfg = (api as unknown as { config?: unknown }).config;
  if (!cfg) {
    return {
      ok: false,
      fallback: "queue",
      reason: "no_config_available_for_steer",
    };
  }

  // Best-effort steer: if the runtime exposes a controller resolver, use
  // it; otherwise we pass undefined and let core throw, which we catch.
  const runtimeMaybe = (api.runtime ?? {}) as Record<string, unknown>;
  const resolveController = runtimeMaybe["resolveControllerForSession"] as
    | ((sessionKey: string) => Promise<unknown> | unknown)
    | undefined;

  if (typeof resolveController !== "function") {
    return {
      ok: false,
      fallback: "queue",
      reason: "runtime_resolveControllerForSession_missing_TODO",
    };
  }

  try {
    const controller = await resolveController(args.sessionKey);
    const result = await control.steerControlledSubagentRun({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cfg: cfg as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller: controller as any,
      entry,
      message: args.message,
    });
    if (result.status === "accepted") {
      return {
        ok: true,
        mode: "steer",
        runId: result.runId,
        label: "label" in result ? result.label : undefined,
      };
    }
    return { ok: false, fallback: "queue", reason: `steer_status:${result.status}` };
  } catch (err) {
    return {
      ok: false,
      fallback: "queue",
      reason: `steer_threw:${(err as Error).message ?? "unknown"}`,
    };
  }
}

/**
 * Lightweight probe used in diagnostic mode (detectInlineSteer=false).
 */
async function probeActiveRun(sessionKey: string): Promise<{ active: boolean; runId?: string }> {
  try {
    const registry = await import("../../../src/agents/subagent-registry-read.js");
    const entry = registry.getLatestSubagentRunByChildSessionKey(sessionKey);
    if (entry && !entry.endedAt) {
      return { active: true, runId: entry.runId };
    }
  } catch {
    // ignore — diagnostic only
  }
  return { active: false };
}

function appendLog(message: string): void {
  const ts = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${ts}] ${message}\n`);
  } catch {
    // never break message handling because of log IO
  }
}
