# Migracao tsa-pt-br-validator: flat-format -> SDK OpenClaw

## Contexto

A versao 0.1.0 do plugin foi escrita no formato "flat" antigo (manifest.json + entry function exportada de src/index.ts), antes do SDK OpenClaw oficial. Em 28/04/2026 refatorei pra usar o padrao SDK canonico (definePluginEntry + api.on hook), seguindo o template de extensions/tsa-cascade-monitor e extensions/tsa-log-bash-exec do fork openclaw-tsa-git.

A logica de validacao (palavras vigiadas, anglicismos, score 0-10, monitorOnly vs enforcement) NAO mudou — apenas o invólucro de plugin. Os 7 testes smoke continuam passando.

## Antes (flat-format, v0.1.0)

```
tsa-pt-br-validator/
├── package.json          # name: "tsa-pt-br-validator", openclaw.kind: "plugin"
├── manifest.json         # id, hooks: { after_tool_call: "src/index.ts#afterToolCall" }
├── tsconfig.json         # rootDir: "src"
└── src/
    ├── index.ts          # export function afterToolCall(ctx, cfg) {...}
    └── smoke.test.ts     # testa afterToolCall direto
```

Carregamento: OpenClaw runtime lia `manifest.json`, importava o symbol `afterToolCall` e chamava manual quando o evento `after_tool_call` disparava. Forma documentada dentro do TSA mas nunca foi parte oficial do SDK upstream.

## Depois (SDK canonico, v0.2.0)

```
tsa-pt-br-validator/
├── package.json              # name: "@openclaw/tsa-pt-br-validator", openclaw.extensions: ["./index.ts"]
├── openclaw.plugin.json      # id + configSchema (JSON Schema)
├── tsconfig.json             # rootDir: ".", inclui index.ts e src/**
├── index.ts                  # definePluginEntry({ id, name, description, register })
└── src/
    ├── plugin.ts             # registerPtBrValidatorPlugin(api) — chama api.on("after_tool_call", ...)
    ├── validator.ts          # logica pura (scoreText, validateText, extractText) — sem efeito colateral
    ├── sdk-shim.d.ts         # tipos stub pro build standalone (substituidos pelos reais quando entrar no monorepo)
    └── smoke.test.ts         # testa validator.ts diretamente (7 testes)
```

Carregamento: OpenClaw runtime detecta `openclaw.extensions` no package.json, carrega `index.ts` (default export = `definePluginEntry({...})`), chama `register(api)` na inicializacao, e o plugin se registra no event bus via `api.on("after_tool_call", handler)`.

## Mudancas principais

| Aspecto                    | Antes (flat)                                       | Depois (SDK)                                                                                       |
| -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| package.json `name`        | `tsa-pt-br-validator`                              | `@openclaw/tsa-pt-br-validator`                                                                    |
| package.json `openclaw`    | `{ kind: "plugin", manifest: "manifest.json" }`    | `{ extensions: ["./index.ts"], compat: { pluginApi: ">=2026.4.25" } }`                             |
| Manifesto                  | `manifest.json` (custom schema TSA)                | `openclaw.plugin.json` (id + configSchema JSON Schema)                                             |
| Entry                      | `src/index.ts` exporta `afterToolCall(ctx, cfg)`   | `index.ts` exporta default `definePluginEntry({...})`                                              |
| Hook registration          | Implicito via `manifest.hooks.after_tool_call`     | Explicito via `api.on("after_tool_call", handler)`                                                 |
| Config flag enable/disable | `manifest.enabled: false`                          | Vem do `openclaw.json` do clone (config field `enabled`)                                           |
| Modo monitor               | `manifest.config.mode: "monitor" \| "enforcement"` | `monitorOnly: true \| false` (boolean, default true)                                               |
| Tipos SDK                  | nenhum (DIY interfaces)                            | `OpenClawPluginApi` de `openclaw/plugin-sdk/plugin-entry`                                          |
| Tools filtradas            | dentro do extractText (Write/Edit/Bash/WebFetch)   | mesma logica + helper `isTextProducingTool()` early-exit                                           |
| Resultado deny             | `{ decision: "deny", reason, suggestion }`         | `{ status: "error", error: "<reason>\n\nSugestoes:\n<suggestion>" }` (formato SDK after_tool_call) |
| Logica de validacao        | misturada com hook handler                         | extraida para `validator.ts` (testavel sem mock SDK)                                               |
| Smoke tests                | 7 testes via `afterToolCall`                       | 7 testes via `validateText`/`scoreText`/`extractText` (mesma cobertura, paralelos 1-pra-1)         |

## Nomes de campos config (renomeados pra camelCase SDK)

| flat (snake_case)    | SDK (camelCase)     |
| -------------------- | ------------------- |
| `mode: "monitor"`    | `monitorOnly: true` |
| `score_threshold`    | `scoreThreshold`    |
| `min_text_length`    | `minTextLength`     |
| `watched_words_path` | `watchedWordsPath`  |
| `anglicisms_path`    | `anglicismsPath`    |
| `log_path`           | `logPath`           |

Defaults inalterados: `enabled: false`, `monitorOnly: true`, `scoreThreshold: 7`, `minTextLength: 200`, paths e log_path apontando para os mesmos lugares.

## Filtragem de tools (inalterada — apenas movida)

O hook `after_tool_call` dispara para QUALQUER tool. Filtramos cedo via `isTextProducingTool(toolName)` para apenas processar:

- **Write** — `params.content` (texto inteiro)
- **Edit** — `params.new_string` (texto novo)
- **Bash** — heredoc dentro de `params.command` (regex `<<EOF ... EOF`)
- **WebFetch** — `result.output` ou `result.text` ou `result` string (top 4000 chars)

Outras tools (Read, Grep, mcp\_\_\*, etc) retornam early `undefined` — zero overhead.

## Backup

A versao flat-format completa esta em `_legacy-flat-format/` para referencia historica e rollback emergencial. Esse diretorio eh ignorado pelo tsc (exclude no tsconfig).

## Build & test

```bash
cd /Users/caduneiva2/Documents/TSA-ACE/research/picks-v31/plugins/tsa-pt-br-validator
npm install   # standalone (sem workspace dep — usa src/sdk-shim.d.ts)
npm run build # tsc -p .
npm run smoke # node --test dist/src/smoke.test.js — 7/7 OK
```

## Quando puxar pro monorepo openclaw-tsa-git

1. Mover pasta para `/opt/openclaw-tsa-git/extensions/tsa-pt-br-validator/`
2. Em `package.json` adicionar `devDependencies["@openclaw/plugin-sdk"]: "workspace:*"`
3. Deletar `src/sdk-shim.d.ts` (os tipos reais vem via node_modules)
4. Adaptar `tsconfig.json` para `extends: "../tsconfig.package-boundary.base.json"` (padrao do monorepo)
5. `pnpm install` na raiz do monorepo

A logica em `validator.ts` e `plugin.ts` continua igual — zero mudanca de codigo necessaria.

## Producao

Nada deployado nesta sessao. O plugin ainda nao foi registrado em nenhum `openclaw.json` de clone. Continua o roadmap original do DEPLOY.md (sync para tsa-llm -> propaga pro clone -> registra com `enabled: false` -> ativa monitor por 7 dias -> ativa enforcement com confirmacao Cadu).
