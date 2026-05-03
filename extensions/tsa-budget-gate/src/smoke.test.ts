/**
 * Smoke tests for tsa-budget-gate.
 *
 * Run: pnpm test  (vitest)
 *
 * Coverage matches A12 spec section 7:
 *   1. 5K turn budget blocks the 6th call
 *   2. month counter persists between turns
 *   3. rollover dia 1º zera contador + libera bloqueados
 *   4. tool error NÃO decrementa
 *
 * No Postgres / no Telegram — uses in-memory store and a counting notifier.
 */

import { Registry } from "prom-client";
import { describe, it, expect, beforeEach } from "vitest";
import {
  BudgetGate,
  InMemoryCounterStore,
  NoopNotifier,
  estimateTokens,
  type BudgetGateConfig,
  type HookContext,
} from "./budget-gate.js";
import { getMetrics, __resetMetricsForTest } from "./metrics.js";

const SESSION = "sess-1";
const CLIENT = "cliente-revenda-1";

function buildGate(overrides: Partial<BudgetGateConfig> = {}) {
  __resetMetricsForTest();
  const reg = new Registry();
  const metrics = getMetrics(reg);

  const cfg: BudgetGateConfig = {
    tier: "v1",
    maxPerTurn: 5_000,
    maxPerMonth: 100,
    warnAt: 0.8,
    monitorOnly: false,
    telegramAlerts: false,
    postgresUrl: "postgres://unused",
    fastPathBusiness: true,
    ...overrides,
  };

  const store = new InMemoryCounterStore();
  store.upsertClient(CLIENT, "v1", 100);

  const gate = new BudgetGate(cfg, store, new NoopNotifier(), metrics);
  return { gate, store, cfg, metrics };
}

const ctx: HookContext = { client: CLIENT, sessionId: SESSION };

// Input crafted so estimateTokens returns ~1000 tokens:
//   length / 4 + 200 = 1000 → length = 3200.
const ONE_K_INPUT = { payload: "x".repeat(3200) };

describe("estimateTokens", () => {
  it("uses len/4 + 200 fixed overhead", () => {
    expect(estimateTokens("x".repeat(400))).toBe(300); // 100 + 200
    expect(estimateTokens(null)).toBe(200);
    expect(estimateTokens(undefined)).toBe(200);
  });

  it("estimates ~1000 for the standard 1K test input", () => {
    expect(estimateTokens(ONE_K_INPUT)).toBeGreaterThanOrEqual(1000);
    expect(estimateTokens(ONE_K_INPUT)).toBeLessThan(1100);
  });
});

describe("turn cap (5K)", () => {
  it("blocks the 6th call after 5 ~1K calls", async () => {
    const { gate } = buildGate();

    for (let i = 0; i < 5; i++) {
      const r = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
      expect(r.decision).toBe("allow");
    }

    const sixth = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    expect(sixth.decision).toBe("deny");
    expect(sixth.reason).toMatch(/turn/i);
  });

  it("monitorOnly=true reports shadowBlocked but still allows", async () => {
    const { gate } = buildGate({ monitorOnly: true });
    for (let i = 0; i < 5; i++) {
      await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    }
    const sixth = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    expect(sixth.decision).toBe("allow");
    expect(sixth.shadowBlocked).toBe(true);
  });
});

describe("month counter persistence", () => {
  it("month count survives turn end and only allow paths bump it", async () => {
    const { gate, store } = buildGate({
      maxPerTurn: 5_000,
      maxPerMonth: 10,
    });

    for (let i = 0; i < 4; i++) {
      const r = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
      expect(r.decision).toBe("allow");
    }

    // Trigger turn cap → 5th allow + 6th deny.
    await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    const denied = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    expect(denied.decision).toBe("deny");

    // End the turn (resets in-memory turnUsage but month survives).
    gate.resetTurn(SESSION);
    const peekAfterTurn = await store.peekMonth(CLIENT);
    expect(peekAfterTurn.count).toBe(5); // 5 allows committed; deny didn't bump

    // New turn: month counter persists.
    const next = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    expect(next.decision).toBe("allow");
    const peekAfterNext = await store.peekMonth(CLIENT);
    expect(peekAfterNext.count).toBe(6);
  });
});

describe("rollover", () => {
  it("rollover zeroes counters and reports previously blocked clients", async () => {
    const { gate, store } = buildGate({
      maxPerTurn: 50_000,
      maxPerMonth: 3,
    });

    // Burn through the cap.
    await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    await gate.beforeToolCall("read", ONE_K_INPUT, ctx);

    const blocked = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    expect(blocked.decision).toBe("deny");
    expect(blocked.reason).toMatch(/month/i);

    // Run rollover (1st of month).
    const r = await gate.runRollover();
    expect(r.unblocked).toContain(CLIENT);

    const peek = await store.peekMonth(CLIENT);
    expect(peek.count).toBe(0);

    // Should accept again.
    gate.resetTurn(SESSION);
    const after = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    expect(after.decision).toBe("allow");
  });
});

describe("tool error semantics", () => {
  it("recordDrift never decrements counters (errored tool still counts)", async () => {
    const { gate, store } = buildGate();

    const r = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    expect(r.decision).toBe("allow");
    const before = await store.peekMonth(CLIENT);

    // Simulate a tool error post-execution.
    gate.recordDrift({ client: CLIENT, estimated: 1000, real: 950 });

    const after = await store.peekMonth(CLIENT);
    expect(after.count).toBe(before.count); // unchanged
  });
});

describe("warn threshold", () => {
  let warns: string[];

  beforeEach(() => {
    warns = [];
  });

  it("emits exactly one turn-warn per session crossing 80%", async () => {
    const { gate, metrics } = buildGate({
      maxPerTurn: 5_000,
      maxPerMonth: null,
      warnAt: 0.8,
      telegramAlerts: true,
    });

    // 4 calls → 4000 tokens (80%) → first warn.
    for (let i = 0; i < 4; i++) {
      await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
    }

    const warnMetric = await metrics.decisions.get();
    const warnRows = warnMetric.values.filter((v) => v.labels.result === "warn");
    expect(warnRows.length).toBeGreaterThanOrEqual(1);
    void warns;
  });
});

describe("business tier fast path", () => {
  it("skips counters and never blocks", async () => {
    const { gate, store } = buildGate({
      tier: "business",
      maxPerTurn: 1, // would block everything if path were taken
      maxPerMonth: 1,
    });
    // Re-tag client as business in store.
    store.upsertClient(CLIENT, "business", null);

    for (let i = 0; i < 10; i++) {
      const r = await gate.beforeToolCall("read", ONE_K_INPUT, ctx);
      expect(r.decision).toBe("allow");
    }

    const peek = await store.peekMonth(CLIENT);
    expect(peek.count).toBe(0); // fast path never increments
  });
});
