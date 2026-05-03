/**
 * tsa-budget-gate plugin registration.
 *
 * Wires the BudgetGate class to the OpenClaw native hook bus. The class itself
 * (in `./budget-gate.js`) is harness-agnostic and unit-testable without a
 * running OpenClaw runtime — see `./smoke.test.ts`.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  BudgetGate,
  HttpTelegramNotifier,
  NoopNotifier,
  PostgresCounterStore,
  type BudgetGateConfig,
  type Tier,
  type TierLimits,
} from "./budget-gate.js";
import { getMetrics } from "./metrics.js";

const DEFAULT_TIERS: Record<Tier, TierLimits> = {
  lab: { maxPerTurn: 50_000, maxPerMonth: null, warnAt: 0.8 },
  v1: { maxPerTurn: 5_000, maxPerMonth: 10_000, warnAt: 0.8 },
  pro: { maxPerTurn: 20_000, maxPerMonth: 100_000, warnAt: 0.8 },
  business: { maxPerTurn: null, maxPerMonth: null, warnAt: null },
};

function readEnvString(name: string): string | null {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Reads plugin config from `api.config`. Falls back to env-driven defaults so
 * the plugin can boot in OpenClaw clones whose openclaw.json hasn't been
 * extended with `extensions["tsa-budget-gate"]` overrides yet (matches the
 * "ships disabled, monitorOnly=true" rollout posture).
 */
function resolveConfig(api: OpenClawPluginApi): BudgetGateConfig {
  const raw = ((api as unknown as { config?: Record<string, unknown> }).config ?? {}) as Record<
    string,
    unknown
  >;

  const tier = (raw.tier as Tier | undefined) ?? "lab";
  const tiers = (raw.tiers as Record<Tier, TierLimits> | undefined) ?? DEFAULT_TIERS;
  const tierLimits = tiers[tier] ?? DEFAULT_TIERS[tier];

  return {
    tier,
    maxPerTurn: (raw.maxPerTurn as number | null | undefined) ?? tierLimits?.maxPerTurn ?? null,
    maxPerMonth: (raw.maxPerMonth as number | null | undefined) ?? tierLimits?.maxPerMonth ?? null,
    warnAt: (raw.warnAt as number | undefined) ?? tierLimits?.warnAt ?? 0.8,
    monitorOnly: (raw.monitorOnly as boolean | undefined) ?? true,
    telegramAlerts: (raw.telegramAlerts as boolean | undefined) ?? true,
    postgresUrl:
      (raw.postgresUrl as string | undefined) ??
      readEnvString("TSA_BUDGET_GATE_PG") ??
      "postgres://tsa:tsa@localhost:5432/tsa_ace",
    telegramBotToken:
      (raw.telegramBotToken as string | null | undefined) ??
      readEnvString("TSA_TELEGRAM_BOT_TOKEN") ??
      readEnvString("BOT_TOKEN") ??
      null,
    telegramAdminChatId:
      (raw.telegramAdminChatId as string | null | undefined) ??
      readEnvString("TSA_TELEGRAM_ADMIN_CHAT_ID") ??
      null,
    telegramClientChatId: (raw.telegramClientChatId as string | null | undefined) ?? null,
    preciseTokenizer: (raw.preciseTokenizer as boolean | undefined) ?? false,
    fastPathBusiness: (raw.fastPathBusiness as boolean | undefined) ?? true,
    tiers,
  };
}

/**
 * Resolves tenant slug + per-call context from the native hook event.
 *
 * In Ace-TSIA v1 each clone is mapped to a single `clients.slug` row. The
 * canonical resolution rule:
 *   1. ctx.tenantId   (multi-tenant runtime, future)
 *   2. ctx.agentId    (current per-agent slug convention)
 *   3. process.env.TSA_BUDGET_GATE_CLIENT (deploy-time override)
 *   4. "ace-tsia"     (default seeded row in sql/schema.sql)
 */
function resolveClientSlug(ctx: Record<string, unknown> | undefined): string {
  const tenantId = ctx?.tenantId as string | undefined;
  if (tenantId) return tenantId;
  const agentId = ctx?.agentId as string | undefined;
  if (agentId) return agentId;
  const envSlug = readEnvString("TSA_BUDGET_GATE_CLIENT");
  if (envSlug) return envSlug;
  return "ace-tsia";
}

function resolveSessionId(
  event: Record<string, unknown> | undefined,
  ctx: Record<string, unknown> | undefined,
): string {
  return (
    (ctx?.sessionKey as string | undefined) ??
    (ctx?.sessionId as string | undefined) ??
    (event?.sessionKey as string | undefined) ??
    "unknown-session"
  );
}

/**
 * Lazy BudgetGate construction — pg.Pool only opens on first hook fire so
 * the plugin can load (and stay enabled:false) in environments without a
 * Postgres reachable from the loader phase.
 */
function createGate(api: OpenClawPluginApi, cfg: BudgetGateConfig): BudgetGate {
  const metrics = getMetrics();
  const notifier = cfg.telegramAlerts
    ? new HttpTelegramNotifier(cfg.telegramBotToken ?? null, cfg.telegramAdminChatId ?? null)
    : new NoopNotifier();

  // require() pg lazily so build does not require pg installed at type-check time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require("pg") as typeof import("pg");
  const pool = new Pool({ connectionString: cfg.postgresUrl });

  pool.on("error", (err: Error) => {
    api.logger.error?.(`tsa-budget-gate pg pool error: ${err.message}`);
  });

  return new BudgetGate(cfg, new PostgresCounterStore(pool), notifier, metrics);
}

export function registerBudgetGate(api: OpenClawPluginApi): void {
  const cfg = resolveConfig(api);
  let gate: BudgetGate | null = null;
  let initFailed = false;

  function ensureGate(): BudgetGate | null {
    if (gate || initFailed) return gate;
    try {
      gate = createGate(api, cfg);
      api.logger.info?.(
        `tsa-budget-gate ready · tier=${cfg.tier} monitorOnly=${cfg.monitorOnly} fastPathBusiness=${cfg.fastPathBusiness}`,
      );
    } catch (err) {
      initFailed = true;
      api.logger.error?.(`tsa-budget-gate init failed: ${(err as Error).message}; failing open`);
    }
    return gate;
  }

  // ---- before_tool_call: enforce gate ----
  api.on("before_tool_call", async (event, ctx) => {
    const g = ensureGate();
    if (!g) return undefined;

    try {
      const tool = (event.toolName as string | undefined) ?? "unknown";
      const params = ((event.params as Record<string, unknown> | undefined) ??
        (event.input as Record<string, unknown> | undefined) ??
        {}) as Record<string, unknown>;

      const result = await g.beforeToolCall(tool, params, {
        client: resolveClientSlug(ctx as Record<string, unknown> | undefined),
        sessionId: resolveSessionId(
          event as Record<string, unknown>,
          ctx as Record<string, unknown> | undefined,
        ),
        clientChatId: cfg.telegramClientChatId ?? null,
      });

      if (result.decision === "deny") {
        const reason = result.reason ?? "budget exceeded";
        api.logger.warn?.(`tsa-budget-gate BLOCK tool=${tool} reason=${reason}`);
        return {
          block: true,
          blockReason: `tsa-budget-gate: ${reason}`,
        };
      }
      return undefined;
    } catch (err) {
      // Any unexpected failure is fail-open: never block tool execution because
      // the gate itself errored. Drift will surface in Prometheus.
      api.logger.error?.(
        `tsa-budget-gate before_tool_call failed: ${(err as Error).message}; passing through`,
      );
      return undefined;
    }
  });

  // ---- after_tool_call: drift calibration ----
  api.on("after_tool_call", async (event, ctx) => {
    const g = ensureGate();
    if (!g) return undefined;
    try {
      const real =
        (event.usage as { totalTokens?: number } | undefined)?.totalTokens ??
        (event.result as { usage?: { totalTokens?: number } } | undefined)?.usage?.totalTokens ??
        null;
      // estimated must come from the prior beforeToolCall; we do not double-count
      // here — drift recording is a no-op when real is unknown.
      g.recordDrift({
        client: resolveClientSlug(ctx as Record<string, unknown> | undefined),
        estimated: 0,
        real,
      });
    } catch (err) {
      api.logger.error?.(`tsa-budget-gate after_tool_call failed: ${(err as Error).message}`);
    }
    return undefined;
  });

  // ---- before_agent_finalize: reset turn counter ----
  // (No on_turn_end native hook exists; before_agent_finalize is the closest
  // semantic — fires once per agent turn before Stop is emitted.)
  api.on("before_agent_finalize", async (_event, ctx) => {
    const g = ensureGate();
    if (!g) return undefined;
    try {
      const sid = resolveSessionId(undefined, ctx as Record<string, unknown> | undefined);
      g.resetTurn(sid);
    } catch (err) {
      api.logger.error?.(`tsa-budget-gate before_agent_finalize failed: ${(err as Error).message}`);
    }
    return undefined;
  });
}
