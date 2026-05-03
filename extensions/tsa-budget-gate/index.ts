/**
 * tsa-budget-gate (Pick A12, Ace-TSIA v3.1) — SDK extension entry point.
 *
 * Registers per-tier budget gates on top of three OpenClaw native hooks:
 *   - before_tool_call    -> token-per-turn + request-per-month enforcement
 *   - after_tool_call     -> drift gauge calibration (heuristic vs real)
 *   - before_agent_finalize -> resets in-memory turn counter
 *
 * Spec: research/picks-v31/A12-budget-gate-spec.md
 *
 * Defaults ship in monitor mode (config.monitorOnly=true): the gate logs
 * SHADOW-BLOCK decisions and populates Prometheus metrics without ever
 * actually returning `block:true`. Flip monitorOnly=false only after a
 * full week of zero false-positive drift in production.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerBudgetGate } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-budget-gate",
  name: "TSA Budget Gate",
  description:
    "Per-tier token/turn + request/month budget gate. Atomic Postgres counters, Telegram notifications, Prometheus metrics. Inspired by code-claude/cost_tracker.py. Ships in monitorOnly=true.",
  register(api) {
    registerBudgetGate(api);
  },
});
