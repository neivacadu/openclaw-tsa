# tsa-local-compactor — Migração flat → SDK OpenClaw

Data: 2026-04-28
Pick: A3 (Heuristic Local Compactor)
Padrão referência: `/opt/openclaw-tsa-git/extensions/tsa-cascade-monitor/`

---

## 1. Por que migrou

A versão inicial (v0.1.0 flat) seguia um contrato caseiro:

```ts
// src/index.ts (legacy)
export interface PluginApi {
  registerHook(name: string, handler: (ctx) => { messages }): void;
}
export function register(api: PluginApi): void { ... }
```

E `manifest.json` no formato OpenClaw legado (`hooks: { before_prompt_build: "compact" }`).

Esse contrato **não bate com o OpenClaw SDK real** (`/opt/openclaw-tsa-git/packages/plugin-sdk`). O fork espera:

- Entry point com `definePluginEntry({ id, name, description, register })`
- `register(api)` recebendo `OpenClawPluginApi`
- Hooks via `api.on("before_prompt_build", (event, ctx) => result)`
- Tipo de retorno do hook: `{ systemPrompt? | prependContext? | prependSystemContext? | appendSystemContext? }` — **não permite reescrever `messages`**
- `package.json` com `name: "@openclaw/<plugin-id>"` + bloco `openclaw.extensions: ["./index.ts"]`
- `openclaw.plugin.json` separado do `package.json` (id + configSchema + uiHints)

Sem refatorar, o plugin não carregaria via plugin loader do fork.

---

## 2. O que mudou

### Estrutura de arquivos

```
ANTES (flat)                          DEPOIS (SDK)
─────────────────────                 ─────────────────────────────────
package.json                          package.json            (@openclaw/...)
manifest.json                         openclaw.plugin.json    (id + configSchema)
tsconfig.json                         tsconfig.json
src/                                  index.ts                (definePluginEntry)
  index.ts  (lógica + register)       src/
  smoke.test.ts                         compact.ts            (lógica pura)
                                        plugin.ts             (SDK adapter / api.on)
                                        index.ts              (re-export retrocompat)
                                        smoke.test.ts
                                      types/
                                        openclaw-sdk.d.ts     (ambient p/ build offline)
                                      _legacy-flat-format/    (backup)
```

### `package.json`

| Campo                 | Antes                     | Depois                                             |
| --------------------- | ------------------------- | -------------------------------------------------- |
| `name`                | `tsa-local-compactor`     | `@openclaw/tsa-local-compactor`                    |
| `type`                | (cjs implícito)           | `"module"`                                         |
| `main` / `types`      | `dist/index.js` / `.d.ts` | removidos (entry vem de `openclaw.extensions`)     |
| `private`             | `true`                    | `true` (mantido)                                   |
| `openclaw.extensions` | —                         | `["./index.ts"]`                                   |
| `openclaw.compat`     | —                         | `{ pluginApi: ">=2026.4.25" }`                     |
| `openclaw.build`      | —                         | `{ openclawVersion: "2026.4.25" }`                 |
| `scripts.smoke`       | —                         | `node --enable-source-maps dist/src/smoke.test.js` |

### `manifest.json` → `openclaw.plugin.json`

- Reduzido a `{ id, name, description, configSchema, metadata }`.
- `enabled`, `main`, `hooks`, `permissions` saíram (não fazem parte do schema SDK; runtime descobre hooks via `api.on(...)` calls dentro do `register`).
- `configSchema` ganhou JSON Schema formal com `type: integer/string/boolean`, `minimum`, `enum`, `default`.
- Estado `enabled:false` agora é decidido em `openclaw.json` do clone (não no manifesto do plugin).

### `tsconfig.json`

| Antes                      | Depois                                                          |
| -------------------------- | --------------------------------------------------------------- |
| `module: CommonJS`         | `module: ES2022`                                                |
| `rootDir: src`             | `rootDir: .`                                                    |
| `include: ["src/**/*.ts"]` | `include: ["./index.ts", "./src/**/*.ts", "./types/**/*.d.ts"]` |
| (sem exclude legacy)       | `exclude: [..., "_legacy-flat-format/**"]`                      |

### Código

**Lógica preservada 1:1** em `src/compact.ts`:

- `compact(messages, cfg)` — heurística completa
- `extractLastUserRequests`, `extractPendingWork`, `extractKeyFiles`, `inferCurrentWork`
- `formatSummary` produz bloco com tags `<summary>` / `</summary>`
- `estimateTokens` usa fórmula `Math.floor(len/4) + 1`
- `DEFAULT_CONFIG`: `preserveRecent=8`, `maxTokens=15000`, `compactTarget=6000`, `mode="heuristic"`, `logBeforeAfter=true`
- `shouldCompact` (gate baseado em `mode + preserveRecent + maxTokens`)
- Constantes `SUMMARY_OPEN`, `SUMMARY_CLOSE`, `PREAMBLE` inalteradas

**Código novo, mínimo**, em `src/plugin.ts`:

```ts
api.on("before_prompt_build", async (event, _ctx) => {
  const cfg = resolveConfig(api.pluginConfig);
  if (cfg.mode === "off") return undefined;
  const msgs = coerceMessages(event.messages);
  if (!shouldCompact(msgs, cfg)) return undefined;
  const out = compact(msgs, cfg);
  return { prependSystemContext: out[0].text };
});
```

E `index.ts` na raiz com 12 linhas chamando `definePluginEntry({...})`.

### Diferença semântica

O contrato antigo `register(api)` retornava `{ messages: Message[] }` — isto é, **substituía** o array de mensagens. O SDK do `before_prompt_build` **não permite** reescrever `messages` (o tipo `PluginHookBeforePromptBuildResult` só aceita `systemPrompt | prependContext | prependSystemContext | appendSystemContext`).

Solução: gerar a mensagem-summary com a mesma lógica, extrair o `text` dela, retornar como `prependSystemContext` (mais cacheável que `prependContext`, mesmo trato que `tsa-channel-skill-bindings` e `diffs` usam). O efeito prático em cascades ACE→subagent é equivalente porque o subagent recebe o resumo como contexto sistema antes do prompt; a diferença é que o histórico bruto continua no `messages` (o SDK não dá hook pra truncá-lo nesse ponto).

Se no futuro quisermos truncar o histórico de fato, o ponto certo é o hook `before_compaction` (PluginHookBeforeCompactionEvent) ou um hook futuro `compact_messages` que ainda não existe na 2026.4.25.

---

## 3. Validação

```bash
$ npm install
added 3 packages, audited 4 packages — 0 vulnerabilities

$ npm run build
> tsc -p tsconfig.json
(zero erros)

$ npm run smoke
mock: 200 messages, ~103035 tokens estimated
PASS 1-shape (output.length=9)
PASS 2-tokens (tOut=4597 < 15000)
PASS 3-idempotence (tags=1, stable)
PASS 4-preserve (last 3 verbatim)
ALL SMOKE TESTS PASSED
```

Os 4 asserts continuam passando — a lógica pura é literalmente o mesmo código.

---

## 4. Próximos passos

1. **Não toca produção** ainda. Plugin fica em `research/picks-v31/plugins/`.
2. Para canary 1 bot, copiar `tsa-local-compactor/` (sem `_legacy-flat-format/` e sem `node_modules/`) pra `/opt/openclaw-tsa-git/extensions/` no clone-target, rodar `bun install` no monorepo, e habilitar via `openclaw.json` `plugins.tsa-local-compactor.enabled = true`.
3. Decisão pendente: `before_prompt_build` injetando `prependSystemContext` é suficiente pro Pick A3, ou precisamos de um hook que reescreve `messages` (proposta upstream pro fork)?
4. Se o Cadu pedir hook real de truncagem, reabrir conversa — não inventar workaround sem autorização (regra `feedback_const05_aluc_paths_versoes`).

---

## 5. Backup

`_legacy-flat-format/` contém os arquivos originais (DEPLOY.md, manifest.json, package.json, src/, tsconfig.json) intactos pra rollback ou referência.
