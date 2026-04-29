# tsa-budget-gate · Migration Flat → SDK

Histórico: a versão original (commit 28/04 manhã, em `_legacy-flat-format/`) seguia o padrão "manifest plano" — `manifest.json` no root, factory function `createBudgetGate`, hooks declarados como strings (`"before_tool_call": "gate"`), e o harness do clone era responsável por chamar a factory. Essa forma não compila contra o fork TSA do OpenClaw em `/opt/openclaw-tsa-git`, que adotou o SDK `@openclaw/plugin-sdk` desde 2026.4.25.

Esta refatoração porta o plugin para o padrão SDK sem tocar a lógica do BudgetGate.

## Sumário das mudanças

| Aspecto                  | Flat (legacy)                                               | SDK (atual)                                                                                                 |
| ------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Package name             | `tsa-budget-gate`                                           | `@openclaw/tsa-budget-gate`                                                                                 |
| Module type              | CommonJS implícito                                          | `"type": "module"`                                                                                          |
| Manifest                 | `manifest.json` (com `enabled`, `entry`, `hooks`, `config`) | `openclaw.plugin.json` (apenas `id` + `configSchema`) + `package.json#openclaw.extensions`                  |
| Entry point              | `dist/index.js` exportando factory                          | `index.ts` exportando `definePluginEntry` default                                                           |
| Hook registration        | Declarativa via manifest `"hooks": { ... }`                 | Imperativa via `api.on("before_tool_call", handler)` em `register()`                                        |
| Block contract           | Factory retorna `{ decision: "deny", reason }` ao harness   | Hook retorna `{ block: true, blockReason: string }` ao SDK                                                  |
| Pasta canônica de deploy | `plugins/tsa-budget-gate/`                                  | `extensions/tsa-budget-gate/`                                                                               |
| pg/notifier wiring       | Lazy require dentro de `createBudgetGate()`                 | Lazy require dentro de `registerBudgetGate()` (mesma estratégia, agora no register hook)                    |
| TS config                | `tsc -p .` direto                                           | `tsconfig.json` (full, requer SDK no workspace) + `tsconfig.local.json` (build sem SDK, só lógica testável) |

## Mapping flat → SDK

### `manifest.json` → `openclaw.plugin.json` + `package.json`

Antes (`_legacy-flat-format/manifest.json`):

```json
{
  "id": "tsa-budget-gate",
  "name": "TSA Budget Gate",
  "enabled": false,
  "entry": "dist/index.js",
  "exports": { "factory": "createBudgetGate" },
  "hooks": {
    "before_tool_call": "gate",
    "after_tool_call": "recordDrift",
    "on_turn_end": "resetTurn"
  },
  "config": { "tier": "lab", "monitorOnly": true, ... }
}
```

Depois:

- `package.json` ganha `openclaw.extensions: ["./index.ts"]` + `compat.pluginApi: ">=2026.4.25"`. É isso que o loader do fork TSA enxerga para registrar o módulo.
- `openclaw.plugin.json` declara só `id` + `configSchema` JSON-Schema (sem `enabled`/`entry`/`hooks`/`config` — esses passam a ser responsabilidade do código).
- `enabled:false` deixa de existir no manifest do plugin. Para manter o plugin desligado por default, o clone deve omitir o ID em `openclaw.json#extensions` ou setar `extensions["tsa-budget-gate"].enabled=false` na config do clone (padrão `tsa-cascade-monitor`).
- `monitorOnly:true` continua sendo o default — agora resolvido em `src/plugin.ts#resolveConfig` quando `api.config` não traz override.

### Hook contract

Antes, o harness do clone era responsável por:

```ts
const gate = createBudgetGate(cfg, deps);
const result = await gate.beforeToolCall(tool, input, ctx);
if (result.decision === "deny") harness.block(result.reason);
```

Agora o SDK chama o callback `register()` exatamente uma vez no boot do clone, e o callback faz `api.on("before_tool_call", handler)`. O handler é responsável por:

1. Resolver `client` e `sessionId` a partir do `event` + `ctx` nativo do SDK (ver `src/plugin.ts#resolveClientSlug` / `#resolveSessionId`).
2. Chamar `gate.beforeToolCall(tool, params, hookCtx)` (a lógica BudgetGate é a mesma).
3. Retornar `{ block: true, blockReason }` quando `decision === "deny"` (formato canônico do SDK — confirmado em `tsa-pre-tool-call-bridge/src/plugin.ts:73`).

### Mapeamento de hooks

| Hook lógico (spec A12) | Flat                               | SDK nativo                             |
| ---------------------- | ---------------------------------- | -------------------------------------- |
| Pré-execução de tool   | `"before_tool_call": "gate"`       | `api.on("before_tool_call", ...)`      |
| Pós-execução / drift   | `"after_tool_call": "recordDrift"` | `api.on("after_tool_call", ...)`       |
| Fim de turn            | `"on_turn_end": "resetTurn"`       | `api.on("before_agent_finalize", ...)` |

**Nota sobre `on_turn_end`:** o fork TSA OpenClaw não emite o hook `on_turn_end` — confirmado via grep em `extensions/tsa-*/src/plugin.ts` (apenas `before_agent_finalize`, `before_tool_call`, `after_tool_call`, `before_prompt_build`, `before_agent_start`, `inbound_claim`, `gateway_start`, `message_received`, `session_end`, `subagent_spawning`). `before_agent_finalize` é a substituição correta — dispara antes do `Stop` do agente, semanticamente "fim de turn".

## Estrutura de arquivos

```
tsa-budget-gate/
├── index.ts                          # NEW: definePluginEntry default export
├── package.json                      # REWRITTEN: @openclaw/* + openclaw.extensions
├── openclaw.plugin.json              # NEW: id + configSchema (substitui manifest.json)
├── tsconfig.json                     # NEW: build:full (requer @openclaw/plugin-sdk no workspace)
├── tsconfig.local.json               # NEW: build local (apenas budget-gate.ts + metrics.ts)
├── vitest.config.ts                  # NEW: exclui _legacy-flat-format do smoke
├── src/
│   ├── plugin.ts                     # NEW: registerBudgetGate(api) — wiring SDK
│   ├── budget-gate.ts                # MOVED: era src/index.ts; lógica IDÊNTICA
│   ├── metrics.ts                    # UNCHANGED
│   └── smoke.test.ts                 # UPDATED: imports `./budget-gate.js` em vez de `./index.js`
├── sql/
│   ├── schema.sql                    # UNCHANGED
│   └── rollover.sh                   # UNCHANGED
├── MIGRATION-FLAT-TO-SDK.md          # this file
└── _legacy-flat-format/              # backup intacto da versão flat
    ├── DEPLOY.md
    ├── manifest.json
    ├── package.json
    ├── sql/
    └── src/
        ├── index.ts                  # antigo monólito (BudgetGate + factory)
        ├── metrics.ts
        └── smoke.test.ts             # mesmo smoke, importando ./index.js
```

## Lógica preservada (verificação manual)

Comparei `_legacy-flat-format/src/index.ts` × `src/budget-gate.ts`:

- ✅ `BudgetGate` class: idêntica linha-a-linha (turnUsage Map, warnedTurn Set, warnedMonth Set, beforeToolCall fluxo peek→tier→limits→turn→month→commit→gauges→warn, resetTurn, recordDrift, runRollover, deny, warn).
- ✅ `estimateTokens`: heurística `len/4 + 200`, fallback null/undefined → 200.
- ✅ Tiers default: lab 50K/null, v1 5K/10K, pro 20K/100K, business null/null. Sem alteração.
- ✅ `PostgresCounterStore`: query `UPDATE clients SET req_count_month = req_count_month + 1 WHERE slug=$1 RETURNING ...` continua atomic.
- ✅ `InMemoryCounterStore`: idêntico.
- ✅ `HttpTelegramNotifier` + `NoopNotifier`: idênticos. Telegram outage segue fail-open.
- ✅ Shadow-block em `monitorOnly=true`: `console.log("[tsa-budget-gate] SHADOW-BLOCK", ...)` + retorna `{ decision: "allow", shadowBlocked: true }`.
- ✅ 3 métricas Prometheus + 1 bonus drift: `tsa_budget_gate_decisions_total`, `tsa_budget_used_pct`, `tsa_budget_warns_sent_total`, `tsa_budget_estimation_drift_pct`. Inalteradas.
- ✅ `createBudgetGate(cfg, deps)` factory mantida em `budget-gate.ts` (consumidores não-SDK como CLIs internos podem continuar usando).

A única adição funcional é em `src/plugin.ts`:

- `resolveClientSlug(ctx)` decide o slug a partir de `ctx.tenantId` → `ctx.agentId` → `env.TSA_BUDGET_GATE_CLIENT` → `"ace-tsia"`. Decisão necessária porque o flat manifest dependia do harness do clone preencher o `client` — o SDK não.
- `resolveSessionId` prefere `ctx.sessionKey`, depois `ctx.sessionId`, depois fallback `"unknown-session"`.
- Lazy `ensureGate()` com flag `initFailed` para não tentar reabrir pg.Pool quebrado a cada hook.
- pg.Pool error handler gritando para `api.logger.error`.
- after_tool_call passa `estimated:0` porque o SDK ainda não correlaciona o `event` com a estimativa salva no before_tool_call. `recordDrift` ignora drift quando estimated=0 — fica como TODO de calibração futura via session storage do SDK.

## Smoke status

```
$ npm run smoke
✓ estimateTokens (2)
✓ turn cap (5K) > monitorOnly=true reports shadowBlocked but still allows
✓ tool error semantics > recordDrift never decrements counters
✓ warn threshold > emits exactly one turn-warn per session crossing 80%
✓ business tier fast path > skips counters and never blocks

✗ turn cap (5K) > blocks the 6th call after 5 ~1K calls
✗ month counter persistence > month count survives turn end and only allow paths bump it
✗ rollover > rollover zeroes counters and reports previously blocked clients

Tests: 6 passed | 3 failed (9 total)
```

**3 falhas são pré-existentes no `_legacy-flat-format/`** — confirmado rodando o smoke do legacy isoladamente (mesmo 6/3). São off-by-ones nos asserts dos testes contra a heurística `len/4+200=1000` e cap=5000 (a 5ª chamada já cruza o limite). Não é regressão da refatoração SDK; é bug do código original.

## Build status

```
$ npm run build      # tsc -p tsconfig.local.json
✓ dist-local/src/budget-gate.{js,d.ts,js.map}
✓ dist-local/src/metrics.{js,d.ts,js.map}
```

`build:full` (que inclui `index.ts` + `src/plugin.ts`) só roda quando o plugin está dentro do fork OpenClaw como `extensions/tsa-budget-gate/` com `@openclaw/plugin-sdk` no workspace pnpm — o import `openclaw/plugin-sdk/plugin-entry` exige isso. No Mac local apenas a lógica do gate é compilável; isso é intencional e idêntico à postura do `tsa-cascade-monitor` (também depende de SDK no workspace).

## Próximo passo (NÃO TOCA PRODUÇÃO)

1. `rsync -av ~/Documents/TSA-ACE/research/picks-v31/plugins/tsa-budget-gate/ tsa-llm:/opt/openclaw-tsa-git/extensions/tsa-budget-gate/ --exclude _legacy-flat-format --exclude node_modules --exclude dist-local`
2. Restaurar `@openclaw/plugin-sdk: workspace:*` em `package.json#devDependencies` (foi removido só pra build local).
3. `cd /opt/openclaw-tsa-git && pnpm install` (resolve workspace).
4. `pnpm --filter @openclaw/tsa-budget-gate build` — agora compila tudo, incluindo SDK entry.
5. Aplicar `sql/schema.sql` em `tsa_ace` (master.tsa) — passo 2 do `_legacy-flat-format/DEPLOY.md` segue válido.
6. Habilitar no clone canary (escolher 1 V1 não-crítico) editando `openclaw.json` do clone:
   ```json
   {
     "extensions": {
       "tsa-budget-gate": {
         "enabled": true,
         "tier": "v1",
         "monitorOnly": true
       }
     }
   }
   ```
7. Restart clone, monitorar `journalctl -u openclaw@<slug> | grep tsa-budget-gate` e `tsa_budget_gate_decisions_total{result=~"deny.*"}` em Prometheus por 7 dias.
8. Só então flip `monitorOnly:false` (decisão Cadu).

Constitution #6 não se aplica ao `ace-tsia-beta` (lab). Em qualquer clone V1 que quebrar com gate ligado, voltar para `monitorOnly:true` antes de desligar (preserva métricas).
