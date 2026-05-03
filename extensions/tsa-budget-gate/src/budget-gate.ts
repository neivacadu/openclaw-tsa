/**
 * tsa-budget-gate (Pick A12, Ace-TSIA v3.1) — core gate logic.
 *
 * Harness-agnostic. Wired to OpenClaw native hooks by `./plugin.ts`. Unit
 * tested by `./smoke.test.ts` against an in-memory counter store — no
 * Postgres / no Telegram / no OpenClaw runtime needed.
 *
 * Spec: research/picks-v31/A12-budget-gate-spec.md
 *
 * Inspired by `code-claude/src/cost_tracker.py` + `costHook.py`.
 *
 * IMPORTANT: ships disabled (manifest.enabled=false). First week runs in
 * monitorOnly=true — logs decisions and populates Prometheus metrics
 * without ever returning `deny`.
 */

import type { Pool, PoolClient } from "pg";
import { getMetrics, type BudgetMetrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "lab" | "v1" | "pro" | "business";

export interface TierLimits {
  maxPerTurn: number | null;
  maxPerMonth: number | null;
  warnAt: number | null; // 0..1
}

export interface BudgetGateConfig {
  tier: Tier;
  maxPerTurn: number | null;
  maxPerMonth: number | null;
  warnAt: number;
  monitorOnly: boolean;
  telegramAlerts: boolean;
  postgresUrl: string;
  telegramBotToken?: string | null;
  telegramAdminChatId?: string | null;
  telegramClientChatId?: string | null;
  preciseTokenizer?: boolean;
  fastPathBusiness?: boolean;
  tiers?: Record<Tier, TierLimits>;
}

export interface HookContext {
  /** Tenant slug — matches `clients.slug` in Postgres. */
  client: string;
  /** Session id from OpenClaw harness. Used to scope per-turn counters. */
  sessionId: string;
  /** Optional tenant-level Telegram chat id (overrides config). */
  clientChatId?: string | null;
}

export type Decision = "allow" | "deny";

export interface HookResult {
  decision: Decision;
  reason?: string;
  /** Set when monitorOnly=true and the gate WOULD have blocked. */
  shadowBlocked?: boolean;
  /** Diagnostic payload — useful for tests and structured logs. */
  diagnostics?: {
    estimatedTokens: number;
    turnUsedAfter: number;
    monthCountAfter: number | null;
    warned: boolean;
    tier: Tier;
  };
}

export interface ToolInput {
  // OpenClaw passes a free-form input. We only stringify it for estimation.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

const FIXED_OVERHEAD_PER_CALL = 200;

export function estimateTokens(input: ToolInput | string | undefined | null): number {
  if (input == null) return FIXED_OVERHEAD_PER_CALL;
  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  // Heuristic per spec section 3: len/4 + 200 fixed overhead.
  return Math.ceil(text.length / 4) + FIXED_OVERHEAD_PER_CALL;
}

// ---------------------------------------------------------------------------
// Telegram notifier (thin wrapper)
// ---------------------------------------------------------------------------

export interface TelegramNotifier {
  notifyClient(chatId: string | null | undefined, msg: string): Promise<void>;
  notifyAdmin(msg: string): Promise<void>;
}

export class HttpTelegramNotifier implements TelegramNotifier {
  constructor(
    private botToken: string | null | undefined,
    private adminChatId: string | null | undefined,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async send(chatId: string, msg: string): Promise<void> {
    if (!this.botToken) return;
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" }),
      });
    } catch (err) {
      // Telegram outage must NEVER block a decision. Log and move on.
      // eslint-disable-next-line no-console
      console.warn("[tsa-budget-gate] telegram send failed", err);
    }
  }

  async notifyClient(chatId: string | null | undefined, msg: string): Promise<void> {
    if (!chatId) return;
    await this.send(chatId, msg);
  }

  async notifyAdmin(msg: string): Promise<void> {
    if (!this.adminChatId) return;
    await this.send(this.adminChatId, msg);
  }
}

export class NoopNotifier implements TelegramNotifier {
  async notifyClient(): Promise<void> {
    /* noop */
  }
  async notifyAdmin(): Promise<void> {
    /* noop */
  }
}

// ---------------------------------------------------------------------------
// Postgres counter store (atomic UPDATE ... RETURNING)
// ---------------------------------------------------------------------------

export interface CounterStore {
  /**
   * Atomically increments req_count_month for `client` and returns the
   * new value plus the resolved tier. Throws if client unknown.
   */
  incrementMonth(client: string): Promise<{ count: number; tier: Tier; cap: number | null }>;

  /**
   * Reads month counter without incrementing. Used for "would I block?"
   * checks in monitorOnly path.
   */
  peekMonth(client: string): Promise<{ count: number; tier: Tier; cap: number | null }>;

  /**
   * Resets month counter — called by rollover cron (1st of month 00:00).
   */
  rolloverAll(): Promise<{ unblocked: string[] }>;
}

export class PostgresCounterStore implements CounterStore {
  constructor(private pool: Pool) {}

  async incrementMonth(client: string): Promise<{ count: number; tier: Tier; cap: number | null }> {
    const sql = `
      UPDATE clients
         SET req_count_month = req_count_month + 1
       WHERE slug = $1
      RETURNING req_count_month, tier, cap_per_month
    `;
    const res = await this.pool.query(sql, [client]);
    if (res.rowCount === 0) {
      throw new Error(`tsa-budget-gate: unknown client slug=${client}`);
    }
    const row = res.rows[0];
    return {
      count: Number(row.req_count_month),
      tier: row.tier as Tier,
      cap: row.cap_per_month == null ? null : Number(row.cap_per_month),
    };
  }

  async peekMonth(client: string): Promise<{ count: number; tier: Tier; cap: number | null }> {
    const res = await this.pool.query(
      `SELECT req_count_month, tier, cap_per_month FROM clients WHERE slug = $1`,
      [client],
    );
    if (res.rowCount === 0) throw new Error(`tsa-budget-gate: unknown client slug=${client}`);
    const row = res.rows[0];
    return {
      count: Number(row.req_count_month),
      tier: row.tier as Tier,
      cap: row.cap_per_month == null ? null : Number(row.cap_per_month),
    };
  }

  async rolloverAll(): Promise<{ unblocked: string[] }> {
    const sql = `
      WITH was_blocked AS (
        SELECT slug FROM clients
         WHERE cap_per_month IS NOT NULL
           AND req_count_month >= cap_per_month
      )
      UPDATE clients
         SET req_count_month = 0,
             month_started_at = CURRENT_DATE
      WHERE TRUE
      RETURNING slug, (SELECT 1 FROM was_blocked WHERE was_blocked.slug = clients.slug) AS was_blocked
    `;
    const res = await this.pool.query(sql);
    const unblocked = res.rows
      .filter((r: { was_blocked: number | null }) => r.was_blocked === 1)
      .map((r: { slug: string }) => r.slug);
    return { unblocked };
  }
}

/** In-memory counter store — used for tests. */
export class InMemoryCounterStore implements CounterStore {
  private counts = new Map<string, number>();
  constructor(private clients: Map<string, { tier: Tier; cap: number | null }> = new Map()) {}

  upsertClient(slug: string, tier: Tier, cap: number | null): void {
    this.clients.set(slug, { tier, cap });
    if (!this.counts.has(slug)) this.counts.set(slug, 0);
  }

  async incrementMonth(client: string) {
    const meta = this.clients.get(client);
    if (!meta) throw new Error(`unknown client ${client}`);
    const current = (this.counts.get(client) ?? 0) + 1;
    this.counts.set(client, current);
    return { count: current, tier: meta.tier, cap: meta.cap };
  }

  async peekMonth(client: string) {
    const meta = this.clients.get(client);
    if (!meta) throw new Error(`unknown client ${client}`);
    return { count: this.counts.get(client) ?? 0, tier: meta.tier, cap: meta.cap };
  }

  /** Test-only: undo last increment when caller wants "tool error doesn't decrement" semantics. */
  async undoIncrement(client: string): Promise<void> {
    const cur = this.counts.get(client) ?? 0;
    this.counts.set(client, Math.max(0, cur - 1));
  }

  async rolloverAll() {
    const unblocked: string[] = [];
    for (const [slug, count] of this.counts.entries()) {
      const meta = this.clients.get(slug);
      if (meta?.cap != null && count >= meta.cap) unblocked.push(slug);
      this.counts.set(slug, 0);
    }
    return { unblocked };
  }
}

// ---------------------------------------------------------------------------
// BudgetGate — the actual hook
// ---------------------------------------------------------------------------

const DEFAULT_TIERS: Record<Tier, TierLimits> = {
  lab: { maxPerTurn: 50_000, maxPerMonth: null, warnAt: 0.8 },
  v1: { maxPerTurn: 5_000, maxPerMonth: 10_000, warnAt: 0.8 },
  pro: { maxPerTurn: 20_000, maxPerMonth: 100_000, warnAt: 0.8 },
  business: { maxPerTurn: null, maxPerMonth: null, warnAt: null },
};

export class BudgetGate {
  /** Per-session token usage. Reset by `resetTurn(sessionId)`. */
  private turnUsage = new Map<string, number>();
  /** Tracks who already received a "warn 80%" this turn — avoid spam. */
  private warnedTurn = new Set<string>();
  /** Tracks who got a month-warn this billing cycle. Cleared by rollover. */
  private warnedMonth = new Set<string>();

  constructor(
    private cfg: BudgetGateConfig,
    private store: CounterStore,
    private notifier: TelegramNotifier,
    private metrics: BudgetMetrics = getMetrics(),
  ) {}

  /** Resolve effective limits — tenant tier overrides plugin-level config. */
  private limitsFor(tier: Tier): TierLimits {
    const map = this.cfg.tiers ?? DEFAULT_TIERS;
    return map[tier] ?? DEFAULT_TIERS[tier];
  }

  /** Hook: before_tool_call. */
  async beforeToolCall(tool: string, input: ToolInput, ctx: HookContext): Promise<HookResult> {
    const estimated = estimateTokens(input);

    // Fast path: business tier is unlimited.
    let resolvedTier: Tier = this.cfg.tier;
    let monthCount: number | null = null;
    let monthCap: number | null = null;

    // Peek so we can resolve tier and decide BEFORE incrementing.
    try {
      const peek = await this.store.peekMonth(ctx.client);
      resolvedTier = peek.tier;
      monthCount = peek.count;
      monthCap = peek.cap;
    } catch (err) {
      // If client row missing, fall back to plugin-level tier and don't block.
      // eslint-disable-next-line no-console
      console.warn("[tsa-budget-gate] peekMonth failed", { client: ctx.client, err });
    }

    if (this.cfg.fastPathBusiness !== false && resolvedTier === "business") {
      this.metrics.decisions.inc({ client: ctx.client, tier: resolvedTier, result: "allow" });
      return {
        decision: "allow",
        diagnostics: {
          estimatedTokens: estimated,
          turnUsedAfter: this.turnUsage.get(ctx.sessionId) ?? 0,
          monthCountAfter: monthCount,
          warned: false,
          tier: resolvedTier,
        },
      };
    }

    const limits = this.limitsFor(resolvedTier);
    const turnUsed = this.turnUsage.get(ctx.sessionId) ?? 0;

    // ---- Turn cap check ----
    if (limits.maxPerTurn != null && turnUsed + estimated > limits.maxPerTurn) {
      return this.deny("deny_turn", "budget exceeded (turn)", ctx, resolvedTier, {
        estimatedTokens: estimated,
        turnUsedAfter: turnUsed,
        monthCountAfter: monthCount,
        warned: false,
        tier: resolvedTier,
      });
    }

    // ---- Month cap check (atomic increment) ----
    let monthAfter: number | null = monthCount;
    if (limits.maxPerMonth != null || monthCap != null) {
      const cap = limits.maxPerMonth ?? monthCap ?? null;
      if (cap != null && (monthCount ?? 0) + 1 > cap) {
        return this.deny("deny_month", "monthly cap exceeded", ctx, resolvedTier, {
          estimatedTokens: estimated,
          turnUsedAfter: turnUsed,
          monthCountAfter: monthCount,
          warned: false,
          tier: resolvedTier,
        });
      }
    }

    // Reserved an allow path — commit increments.
    try {
      const inc = await this.store.incrementMonth(ctx.client);
      monthAfter = inc.count;
      monthCap = inc.cap;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[tsa-budget-gate] incrementMonth failed", { client: ctx.client, err });
    }

    const turnAfter = turnUsed + estimated;
    this.turnUsage.set(ctx.sessionId, turnAfter);

    // ---- Gauges ----
    if (limits.maxPerTurn) {
      this.metrics.usedPct.set(
        { client: ctx.client, tier: resolvedTier, scope: "turn" },
        Math.min(100, (turnAfter / limits.maxPerTurn) * 100),
      );
    }
    if (monthCap != null && monthAfter != null) {
      this.metrics.usedPct.set(
        { client: ctx.client, tier: resolvedTier, scope: "month" },
        Math.min(100, (monthAfter / monthCap) * 100),
      );
    }

    // ---- Warn threshold ----
    let warned = false;
    if (limits.warnAt != null) {
      if (
        limits.maxPerTurn &&
        turnAfter / limits.maxPerTurn >= limits.warnAt &&
        !this.warnedTurn.has(ctx.sessionId)
      ) {
        await this.warn(ctx, resolvedTier, "turn", turnAfter, limits.maxPerTurn);
        this.warnedTurn.add(ctx.sessionId);
        warned = true;
      }
      if (
        monthCap != null &&
        monthAfter != null &&
        monthAfter / monthCap >= limits.warnAt &&
        !this.warnedMonth.has(ctx.client)
      ) {
        await this.warn(ctx, resolvedTier, "month", monthAfter, monthCap);
        this.warnedMonth.add(ctx.client);
        warned = true;
      }
    }

    this.metrics.decisions.inc({ client: ctx.client, tier: resolvedTier, result: "allow" });

    return {
      decision: "allow",
      diagnostics: {
        estimatedTokens: estimated,
        turnUsedAfter: turnAfter,
        monthCountAfter: monthAfter,
        warned,
        tier: resolvedTier,
      },
    };
  }

  /** Hook: on_turn_end. Reset per-session counters. */
  resetTurn(sessionId: string): void {
    this.turnUsage.delete(sessionId);
    this.warnedTurn.delete(sessionId);
  }

  /**
   * Hook: after_tool_call. Captures real billed tokens (when harness has
   * them) and pushes drift gauge for calibration.
   *
   * Per spec edge cases: tool ERROR does NOT decrement — input was sent.
   * So this hook is purely observational — never mutates counters.
   */
  recordDrift(opts: { client: string; estimated: number; real: number | null }): void {
    if (opts.real == null || opts.real <= 0) return;
    const drift = ((opts.real - opts.estimated) / opts.real) * 100;
    this.metrics.estimationDrift.set({ client: opts.client }, drift);
  }

  /** Manual rollover entrypoint — invoked by cron job (sql/rollover.sh). */
  async runRollover(): Promise<{ unblocked: string[] }> {
    const result = await this.store.rolloverAll();
    this.warnedMonth.clear();
    for (const slug of result.unblocked) {
      await this.notifier.notifyClient(
        this.cfg.telegramClientChatId ?? null,
        `Cap mensal renovado. Voce tem requests novos para o mes.`,
      );
      this.metrics.warnsSent.inc({ client: slug, channel: "telegram_client" });
    }
    await this.notifier.notifyAdmin(
      `tsa-budget-gate rollover OK — ${result.unblocked.length} clientes desbloqueados.`,
    );
    this.metrics.warnsSent.inc({ client: "_admin_", channel: "telegram_admin" });
    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async deny(
    metric: "deny_turn" | "deny_month",
    reason: string,
    ctx: HookContext,
    tier: Tier,
    diagnostics: NonNullable<HookResult["diagnostics"]>,
  ): Promise<HookResult> {
    this.metrics.decisions.inc({ client: ctx.client, tier, result: metric });

    const msg =
      metric === "deny_turn"
        ? "Limite por turn excedido. Tente reduzir a tarefa ou pedir compact."
        : "Cap mensal atingido. Aguardando rollover dia 1o. Upgrade Pro disponivel.";

    if (this.cfg.telegramAlerts) {
      await this.notifier.notifyClient(
        ctx.clientChatId ?? this.cfg.telegramClientChatId ?? null,
        msg,
      );
      this.metrics.warnsSent.inc({ client: ctx.client, channel: "telegram_client" });
      await this.notifier.notifyAdmin(`[budget_gate] ${metric} client=${ctx.client} tier=${tier}`);
      this.metrics.warnsSent.inc({ client: ctx.client, channel: "telegram_admin" });
    }

    if (this.cfg.monitorOnly) {
      // eslint-disable-next-line no-console
      console.log("[tsa-budget-gate] SHADOW-BLOCK", {
        client: ctx.client,
        tier,
        metric,
        reason,
        diagnostics,
      });
      return { decision: "allow", shadowBlocked: true, reason, diagnostics };
    }

    return { decision: "deny", reason, diagnostics };
  }

  private async warn(
    ctx: HookContext,
    tier: Tier,
    scope: "turn" | "month",
    used: number,
    cap: number,
  ): Promise<void> {
    this.metrics.decisions.inc({ client: ctx.client, tier, result: "warn" });
    if (!this.cfg.telegramAlerts) return;
    const pct = Math.round((used / cap) * 100);
    const msg = `Voce esta em ${pct}% do cap ${scope} — atencao.`;
    await this.notifier.notifyClient(
      ctx.clientChatId ?? this.cfg.telegramClientChatId ?? null,
      msg,
    );
    this.metrics.warnsSent.inc({ client: ctx.client, channel: "telegram_client" });
  }
}

// ---------------------------------------------------------------------------
// Factory entry — kept for direct (non-OpenClaw) consumers and tests.
// The SDK extension entry (`./plugin.ts` -> `registerBudgetGate`) does not
// route through this; it constructs BudgetGate directly so it can wire its
// own pg.Pool error handler to api.logger.
// ---------------------------------------------------------------------------

export interface FactoryDeps {
  pgPool?: Pool;
  notifier?: TelegramNotifier;
}

export function createBudgetGate(cfg: BudgetGateConfig, deps: FactoryDeps = {}): BudgetGate {
  let store: CounterStore;
  if (deps.pgPool) {
    store = new PostgresCounterStore(deps.pgPool);
  } else {
    // Lazy import: keeps `pg` out of test bundles.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool } = require("pg") as typeof import("pg");
    const pool = new Pool({ connectionString: cfg.postgresUrl });
    store = new PostgresCounterStore(pool);
  }
  const notifier =
    deps.notifier ??
    (cfg.telegramAlerts
      ? new HttpTelegramNotifier(cfg.telegramBotToken ?? null, cfg.telegramAdminChatId ?? null)
      : new NoopNotifier());
  return new BudgetGate(cfg, store, notifier);
}

export { getMetrics } from "./metrics.js";
export type { Pool, PoolClient };
