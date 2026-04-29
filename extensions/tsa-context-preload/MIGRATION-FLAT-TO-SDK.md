# Migração `tsa-context-preload`: flat → SDK OpenClaw

Refactor 0.1.0 → 0.2.0. Migra do formato flat antigo (manifest.json + register
ad-hoc) pro padrão SDK do fork OpenClaw-TSA (`definePluginEntry` +
`api.on("before_prompt_build", ...)`).

Sem mudança de comportamento. Lógica preservada 1:1. 4 smoke asserts continuam
verdes (happy path · budget overflow · agent não-targetado · workspace vazio).

## Por que migrar

O fork OpenClaw-TSA (>=2026.4.25) carrega plugins via `package.json` campo
`openclaw.extensions[]` apontando pro entry module, que **deve** exportar
default um `definePluginEntry({...})`. Plugins flat (manifest.json + `entry +
exports.factory`) não são mais reconhecidos pelo loader e ficam silenciosamente
desativados.

Referências canônicas no fork:

- `/opt/openclaw-tsa-git/extensions/tsa-cascade-monitor/` — exemplo MVP TSA
- `/opt/openclaw-tsa-git/extensions/active-memory/` — exemplo `before_prompt_build`
- `/opt/openclaw-tsa-git/extensions/diffs/src/plugin.ts` — exemplo
  `appendSystemContext`
- `/opt/openclaw-tsa-git/src/plugins/hook-before-agent-start.types.ts` — shape
  do `PluginHookBeforePromptBuildResult`
- `/opt/openclaw-tsa-git/src/plugin-sdk/plugin-entry.ts` — `definePluginEntry`

## Mudanças

### 1. `package.json`

| 0.1.0 (flat)                              | 0.2.0 (SDK)                                    |
| ----------------------------------------- | ---------------------------------------------- |
| `name: "tsa-context-preload"`             | `name: "@openclaw/tsa-context-preload"`        |
| `openclaw.pluginType: "hook"`             | `openclaw.extensions: ["./dist/index.js"]`     |
| `openclaw.hooks: ["before_prompt_build"]` | (removido — declarado em runtime via `api.on`) |
| `tier`/`owner` em `openclaw.*`            | mantidos em `openclaw.*`                       |
| sem `compat`                              | `openclaw.compat.pluginApi: ">=2026.4.25"`     |
| sem `build`                               | `openclaw.build.openclawVersion: "2026.4.25"`  |
| sem `smoke` script                        | `scripts.smoke: "vitest run"`                  |
| sem `type`                                | `type: "module"`                               |

### 2. `manifest.json` → `openclaw.plugin.json`

`manifest.json` (formato flat) substituído por `openclaw.plugin.json` (formato
SDK). Diferenças:

- `id` continua igual (`tsa-context-preload`)
- `enabled`, `entry`, `exports`, `hooks`, `metricsEndpoint`, `ordering`,
  `rolloutNotes` saem — são gerenciados pelo loader SDK
- `config` (defaults inline) sai → defaults agora em
  `src/plugin.ts:DEFAULT_CONFIG`
- Adicionado `configSchema` (JSON Schema) — o loader valida user config contra
  ele antes de chamar `register`

### 3. `src/index.ts`

Antes (0.1.0): single file 348 linhas com classe + `register(api)` ad-hoc no
fim. `register` recebia `api.registerHook(name, handler)` + `api.config`.

Depois (0.2.0):

```ts
// src/index.ts — só wiring SDK
import { definePluginEntry } from "./sdk-types.js";
import { registerContextPreload } from "./plugin.js";

export default definePluginEntry({
  id: "tsa-context-preload",
  name: "TSA Context Preload",
  description: "...",
  register(api) {
    registerContextPreload(api);
  },
});
// + re-exports da API antiga pra não quebrar smoke
```

```ts
// src/plugin.ts — toda a lógica + handler SDK
export function registerContextPreload(api: OpenClawPluginApi): void {
  const resolveCfg = () => resolveConfig(api.pluginConfig as Record<string, unknown>);
  api.on("before_prompt_build", createBeforePromptBuildHandler(resolveCfg, api.logger));
}
```

`api.config` (0.1.0) → `api.pluginConfig` (SDK). Resolver novo
(`resolveConfig`) merge com `DEFAULT_CONFIG` para tolerar config parcial e
campos desconhecidos.

### 4. Hook contract

Antes (0.1.0): handler retornava `{ systemPromptAppend: string, metadata: ... }`
em formato proprietário do projeto.

Depois (0.2.0): handler retorna `PluginHookBeforePromptBuildResult` real do
SDK:

```ts
return { appendSystemContext: res.systemPromptAppend };
```

`appendSystemContext` (cacheable system block) escolhido sobre `prependContext`
(per-turn) porque o conteúdo é ~estável dentro de uma janela curta — pega
prompt cache do Anthropic. Mesma escolha que `diffs/src/plugin.ts` faz.

### 5. SDK types — shim local

Picks-v31 é playground standalone (sem `@openclaw/plugin-sdk` no npm). Mantemos
um shim mínimo em `src/sdk-types.ts` com só as superfícies usadas:
`OpenClawPluginApi`, `PluginHookBeforePromptBuildEvent`,
`PluginHookBeforePromptBuildResult`, `definePluginEntry`. Estruturalmente
compatível com o SDK real.

Ao mover pro fork (`/opt/openclaw-tsa-git/extensions/tsa-context-preload/`),
substitui o import `./sdk-types.js` por `openclaw/plugin-sdk/plugin-entry`
nos 2 lugares (`src/plugin.ts` e `src/index.ts`) e remove `src/sdk-types.ts`.
Tudo o mais é zero-touch.

Patch para deploy no fork:

```ts
// src/index.ts e src/plugin.ts
- import { definePluginEntry } from "./sdk-types.js";
- import type { ... } from "./sdk-types.js";
+ import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
```

### 6. Smoke tests

Smoke tests (`src/smoke.test.ts`) **não mudaram**. Continuam importando
`ContextPreload`, `estimateTokens`, `ContextPreloadConfig` de `./index.js`
(re-exports preservados). 4 asserts OK:

1. happy path — recent memories/artifacts/turns presentes, antigos excluídos
2. budget overflow — 50 memórias com first-line longa, `maxTokens: 300`
3. agent não-targetado — `agentId: "9-other"` retorna `skipped: true`
4. workspace vazio — não throwa, retorna bloco header só

## Backup `_legacy-flat-format/`

Preservado em `_legacy-flat-format/` no diretório do plugin:

- `package.json` — versão 0.1.0 com `pluginType:"hook"`
- `manifest.json` — formato flat completo com defaults inline
- `tsconfig.json` — config TS original (idêntica)
- `index.ts.legacy` — `src/index.ts` 0.1.0 monolítico de 348 linhas

Pra rollback: copiar arquivos de volta + `npm install && npm run build`.
Plugin vai voltar a operar no formato flat.

## Comandos de verificação

```bash
cd research/picks-v31/plugins/tsa-context-preload
npm install
npm run build      # tsc clean
npm run smoke      # 4/4 green
```

Saída esperada:

```
Test Files  1 passed (1)
     Tests  4 passed (4)
```

## Não tocado em produção

Refactor é local ao playground picks-v31. **Nenhum** arquivo em
`/opt/openclaw-tsa-git/` no tsa-llm foi modificado. Deploy real (P0-A) segue
o checklist em `DEPLOY.md` quando flag de manutenção for aberta.

## Métricas Prometheus — preservadas

3 métricas idênticas a 0.1.0:

- `tsa_context_preload_runs_total{result}` — Counter
- `tsa_context_preload_tokens_injected` — Histogram
  (buckets `[100, 500, 1000, 2000, 3000, 4000, 5000, 8000]`)
- `tsa_context_preload_artifacts_count` — Gauge

Singleton via `getMetrics()`. Registry separado pra não vazar entre instâncias
(mesmo padrão do 0.1.0).

## Config inalterada — defaults

| Campo                | Valor                                                 |
| -------------------- | ----------------------------------------------------- |
| `memoryDaysBack`     | `3`                                                   |
| `artifactsHoursBack` | `24`                                                  |
| `lastSessionTurns`   | `20`                                                  |
| `maxTokens`          | `5000`                                                |
| `memoryDir`          | `/home/ace-tsia/.openclaw/workspace/memory`           |
| `artifactsDirs`      | `["/home/ace-tsia/.openclaw/workspace"]`              |
| `artifactExtensions` | `["html","pdf","doc","docx","md","png","jpg","jpeg"]` |
| `publicUrlPrefix`    | `https://ace.caduneiva.com/`                          |
| `publicUrlBasePath`  | `/var/www/ace/`                                       |
| `sessionsDir`        | `/home/ace-tsia/.openclaw/sessions`                   |
| `agentsToInject`     | `["0-ace"]`                                           |

Operador pode override qualquer um via `openclaw.json` `plugins.entries["tsa-context-preload"]` — `resolveConfig()` faz merge limpo.
