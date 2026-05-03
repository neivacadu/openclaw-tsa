/**
 * Prometheus metrics for tsa-budget-gate.
 *
 * Scrape via OpenClaw's existing /metrics endpoint (Camada 7).
 *
 * Exported:
 *   - tsa_budget_gate_decisions_total{client, tier, result}
 *       Counter; result in {allow, deny_turn, deny_month, warn}.
 *   - tsa_budget_used_pct{client, tier, scope}
 *       Gauge; scope in {turn, month}; value 0..100.
 *   - tsa_budget_warns_sent_total{client, channel}
 *       Counter; channel in {telegram_client, telegram_admin}.
 *
 * Bonus (drift calibration, mentioned in spec section 3 / 8):
 *   - tsa_budget_estimation_drift_pct{client}
 *       Gauge; (real - estimated) / real * 100. Populated by after_tool_call.
 */

import { Counter, Gauge, Registry, register as defaultRegister } from "prom-client";

export type DecisionResult = "allow" | "deny_turn" | "deny_month" | "warn";
export type BudgetScope = "turn" | "month";
export type WarnChannel = "telegram_client" | "telegram_admin";

export interface BudgetMetrics {
  decisions: Counter<string>;
  usedPct: Gauge<string>;
  warnsSent: Counter<string>;
  estimationDrift: Gauge<string>;
  registry: Registry;
}

let singleton: BudgetMetrics | null = null;

/**
 * Returns a process-wide singleton metric set. OpenClaw loads the plugin
 * once per process, so we want a single registration to avoid
 * `prom-client` "already registered" errors on hot reload.
 *
 * If `register` is supplied (e.g. tests), we build a fresh set bound to it.
 */
export function getMetrics(register?: Registry): BudgetMetrics {
  if (!register && singleton) return singleton;

  const reg = register ?? defaultRegister;

  const decisions = new Counter({
    name: "tsa_budget_gate_decisions_total",
    help: "Number of budget gate decisions, partitioned by result.",
    labelNames: ["client", "tier", "result"],
    registers: [reg],
  });

  const usedPct = new Gauge({
    name: "tsa_budget_used_pct",
    help: "Current budget usage percentage (0..100) per scope.",
    labelNames: ["client", "tier", "scope"],
    registers: [reg],
  });

  const warnsSent = new Counter({
    name: "tsa_budget_warns_sent_total",
    help: "Number of warn/block notifications sent (Telegram).",
    labelNames: ["client", "channel"],
    registers: [reg],
  });

  const estimationDrift = new Gauge({
    name: "tsa_budget_estimation_drift_pct",
    help: "Drift between heuristic-estimated tokens and real billed tokens, %",
    labelNames: ["client"],
    registers: [reg],
  });

  const set: BudgetMetrics = { decisions, usedPct, warnsSent, estimationDrift, registry: reg };
  if (!register) singleton = set;
  return set;
}

/**
 * Test helper — wipes the singleton so that the next getMetrics() call
 * re-registers everything on a fresh registry. Never call in production.
 */
export function __resetMetricsForTest(): void {
  if (singleton) {
    try {
      singleton.registry.clear();
    } catch {
      /* ignore */
    }
  }
  singleton = null;
}
