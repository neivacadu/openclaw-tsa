# MIGRATION — tsa-skills-rank: flat 0.1.0 -> SDK 0.2.0

> Refactor 28/04 (P0-B Ace-TSIA v3.1). Logica preservada (SkillsRanker class
> 641 LOC, FTS5 ranking, schema SQLite, scripts/index-skills.sh). Apenas a
> casca de plugin migrada do formato flat-manifest pro padrao SDK
> `definePluginEntry({register})` usado em producao por
> `/opt/openclaw-tsa-git/extensions/*` (cascade-monitor, log-bash-exec,
> bmad-router, etc.).

## Por que mudar

O formato 0.1.0 tinha tres problemas:

1. **Manifest legado nao bate com o loader canonico do fork TSA.**
   Producao espera `openclaw.plugin.json` (configSchema apenas) +
   `openclaw.extensions: ["./index.ts"]` no `package.json`, com
   `definePluginEntry` exportado default. O 0.1.0 usava `manifest.json`
   estilo OpenClaw 4.20-beta (chave `openclawPlugin`, hooks com
   `handler: "onBeforePromptBuild"`).
2. **Hooks via export funcional perdem o api.** Ace-TSIA v1.1 tras
   plugins que precisam de `api.logger`, `api.pluginConfig`, `api.on(...)`.
   O modelo flat exportava `onBeforePromptBuild(ctx)` e nao recebia o
   handle do api.
3. **Tools registradas em manifest nao podem usar contexto rico.**
   `api.registerTool({execute(toolCallId, params, signal)})` e o caminho
   canonico — abre porta pra abort signals e tipagem AnyAgentTool.

Cadu pediu (28/04 03h00 BRT): "refatora ao padrao SDK, NAO toca producao".
Backup integral em `_legacy-flat-format/`.

## Mudancas

### Estrutura de arquivos

```
ANTES (0.1.0)                          DEPOIS (0.2.0)
─────────────                          ─────────────
package.json   (openclawPlugin: {})    package.json   (openclaw: {extensions})
manifest.json  (entry, hooks, tools)   manifest.json  (legacy mirror, _sdk_note)
                                       openclaw.plugin.json  (configSchema canonico)
                                       index.ts             (definePluginEntry shell)
src/
  index.ts     (641 LOC tudo junto)    src/
                                         skills-ranker.ts  (logica pura, 460 LOC)
                                         plugin.ts         (SDK wiring,    180 LOC)
                                         smoke.test.ts     (7 → 8 cenarios)
                                       types/
                                         plugin-entry-stub.d.ts (SDK shim standalone)
sql/schema.sql                         sql/schema.sql        (inalterado)
scripts/index-skills.sh                scripts/index-skills.sh (path: dist/src/skills-ranker.js)
DEPLOY.md                              DEPLOY.md              (inalterado)
                                       MIGRATION-FLAT-TO-SDK.md (este arquivo)
                                       _legacy-flat-format/   (backup integral 0.1.0)
```

### `package.json`

| Campo                    | 0.1.0                                               | 0.2.0                                                                             |
| ------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `name`                   | `tsa-skills-rank`                                   | `@openclaw/tsa-skills-rank`                                                       |
| `version`                | `0.1.0`                                             | `0.2.0`                                                                           |
| `main`                   | `src/index.ts`                                      | `dist/index.js`                                                                   |
| `types`                  | (none)                                              | `dist/index.d.ts`                                                                 |
| `scripts.build`          | `tsc -p .`                                          | `tsc -p tsconfig.json` (idem)                                                     |
| `scripts.smoke`          | (era `test`: `tsx src/smoke.test.ts`)               | `node --enable-source-maps dist/src/smoke.test.js`                                |
| `scripts.test`           | `tsx src/smoke.test.ts`                             | mesmo binario do smoke                                                            |
| `scripts.index`          | `bash scripts/index-skills.sh`                      | (inalterado)                                                                      |
| `dependencies`           | better-sqlite3, gray-matter                         | (inalterado)                                                                      |
| `devDependencies`        | tsx, typescript, @types/node, @types/better-sqlite3 | typescript, @types/node, @types/better-sqlite3 (tsx removido)                     |
| `openclawPlugin` (chave) | `{hooks, tools, owner, tier}`                       | (removido)                                                                        |
| `openclaw`               | (none)                                              | `{extensions:["./index.ts"], compat, build, tier, owner}`                         |
| `_sdk_note`              | (none)                                              | comenta que `@openclaw/plugin-sdk: workspace:*` so existe no monorepo de producao |

### `openclaw.plugin.json` (NOVO)

JSON Schema completo com `topN`, `fts5Weight`, `useRecencyWeight`,
`successRateWeight`, `categoryMatchWeight`, `skillsDir`, `dbPath`,
`reindexCron`, `snapshotKey`, `recencyWindowDays`, `metricsPushgateway`.
Defaults preservam os valores 0.1.0:

```json
{
  "topN": 50,
  "fts5Weight": 0.4,
  "useRecencyWeight": 0.3,
  "successRateWeight": 0.2,
  "categoryMatchWeight": 0.1,
  "skillsDir": "/home/ace-tsia/.openclaw/workspace/skills",
  "dbPath": "/home/ace-tsia/.openclaw/data/skills.sqlite",
  "reindexCron": "0 4 * * *",
  "snapshotKey": "skillsSnapshot",
  "recencyWindowDays": 30
}
```

### `index.ts` (NOVO, top-level)

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSkillsRanker } from "./src/plugin.js";

export default definePluginEntry({
  id: "tsa-skills-rank",
  name: "TSA Skills Rank",
  description: "...",
  register(api) {
    registerSkillsRanker(api);
  },
});
```

### `src/plugin.ts` — SDK wiring

Substitui as exports `onBeforePromptBuild` / `onAfterToolCall` /
`toolSkillSearch` por uma unica funcao `registerSkillsRanker(api)`:

| Antes (export funcional)                                              | Depois (api callback)                                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `onBeforePromptBuild(ctx)` muta `ctx.systemPrompt.vars[snapshotKey]`  | `api.on("before_prompt_build", (event, ctx) => ({ appendSystemContext: snapshot }))`                              |
| `onAfterToolCall(ctx)` ouve `ctx.tool.name === "skill_invoke"`        | `api.on("after_tool_call", (event, ctx) => ...)` reading `event.toolName`, `event.params.skill_id`, `event.error` |
| `toolSkillSearch(ctx)` exportado pra ser chamado pelo manifest loader | `api.registerTool({ name: "skill_search", execute: async (toolCallId, rawParams) => ... })`                       |

#### Por que `appendSystemContext` (nao `vars[]`)?

`PluginHookBeforePromptBuildResult.appendSystemContext` foi feito pra ser
**cacheavel pelo provider** (prompt cache do Anthropic, gateway cache,
etc.). Manter o snapshot la em vez de mutar variaveis de prompt economiza
tokens e faz o cache hitar entre turns que so trocam a mensagem do user.

### `src/skills-ranker.ts` — logica pura, byte-equivalente

A classe `SkillsRanker` e tudo embaixo dela (DEFAULT_CONFIG, INLINE_SCHEMA,
`pushMetrics`, `RankerConfig`, `RankedSkill`, `SkillRow`, `ParsedSkill`)
foram movidas IDENTICAS de `src/index.ts` 0.1.0 pra `src/skills-ranker.ts`
0.2.0. Unicas mudancas:

1. **Resolucao do path do schema.sql:** `__dirname` (CommonJS) trocado por
   `dirname(fileURLToPath(import.meta.url))` (ESM NodeNext), com um array
   de candidates pra cobrir tanto rodar a partir de `dist/src/` (compilado)
   quanto de `src/` (caso de tsx no futuro).
2. **Getter publico `config`:** adicionado `get config()` exposto so-leitura
   pra que `src/plugin.ts` consiga ler `ranker.config.topN` sem alcanca
   privada.

Nada mais mudou: o ranking algorithm (FTS5 + recency + use_count log10
boost + success_rate + category match), o cache 5-min `rank_cache`, a
fallback by usage, o snapshot formatter, o `recordInvocation` com
`success_rate * 0.95 +/- 0.05`, e o INLINE_SCHEMA estao byte-iguais.

### `src/smoke.test.ts` — 7 cenarios + 1 novo

- T1 indexa 50 skills mock — **inalterado**
- T2 rank query relevante — **inalterado**
- T3 invocation tracking — **inalterado**
- T4 boost by usage — **inalterado**
- T5 tool skill_search — **migrado pra harness SDK** (mock `OpenClawPluginApi`, chama `tool.execute("call-1", { query, limit })`)
- T6 fallback empty query — **inalterado**
- T7 snapshot — **inalterado**
- **T8 NOVO:** registerSkillsRanker engancha `before_prompt_build` +
  `after_tool_call`, retorna `appendSystemContext` no primeiro, ignora
  tools nao-`skill_invoke` no segundo, e bumpa `use_count` quando
  `skill_invoke` dispara. Le `use_count` direto do SQLite pra contornar o
  `rank_cache` (TTL 5min).

Saida atual: `[smoke] OK — todos os 8 testes passaram`.

### `tsconfig.json` — paths shim

```json
{
  "paths": {
    "openclaw/plugin-sdk/plugin-entry": ["./types/plugin-entry-stub.d.ts"]
  }
}
```

E `module: "NodeNext"` + `moduleResolution: "NodeNext"` em vez de
`commonjs`, alinhando com `tsa-bmad-router` e o SDK contract paths
(`tsconfig.package-boundary.paths.json` no monorepo de producao).

### `types/plugin-entry-stub.d.ts` (NOVO)

Type shim local pra que `tsc` compile fora do monorepo. Declara
`OpenClawPluginApi` (com `on`, `registerHook`, `registerTool`, `logger`,
`pluginConfig`), os event types (`PluginHookBeforePromptBuildEvent`,
`PluginHookAfterToolCallEvent`, `PluginHookAgentContext`), o
`PluginHookBeforePromptBuildResult` (com `appendSystemContext`), e
`definePluginEntry`. Em producao, `tsconfig.package-boundary.paths.json`
do monorepo redireciona o mesmo import pro SDK real
(`../dist/plugin-sdk/src/plugin-sdk/plugin-entry.d.ts`).

### `manifest.json` (legado, mantido)

Mantido como espelho pra harnesses antigos que ainda querem ler manifest.
Atualizado com `_sdk_note`, version 0.2.0, e handlers todos apontando pra
`registerSkillsRanker` (a funcao unica de registro). `openclaw.plugin.json`
e o canonico daqui pra frente.

### `scripts/index-skills.sh`

Trocou a chamada `tsx src/index.ts` por `node dist/src/skills-ranker.js`.
Pre-req agora e `npm install && npm run build` antes do primeiro index.
Remove a dependencia em tsx (devDep tambem foi removida do package.json).

## Compatibilidade com producao

- **Loader canonico TSA fork (>= 4.24):** funciona — `package.json`
  declara `openclaw.extensions: ["./index.ts"]` e exporta default
  `definePluginEntry({...})`. `openclaw.plugin.json` valida via JSON
  Schema. Path do SDK resolve via tsconfig do monorepo.
- **Loader legado (4.20-beta com manifest.json):** `manifest.json`
  segue presente, mas com handlers apontando pra `registerSkillsRanker`.
  Funcionalidade parcial — recomendado bumpar fork pra >= 4.24 antes de
  habilitar enabled:true.
- **better-sqlite3 nativo:** `npm install` builda contra Node 20 local.
  Em producao, `npm install --omit=dev` no destino (ace-tsia ja roda
  Node 20) cobre. Sem mudanca operacional.

## Como testar localmente

```bash
cd research/picks-v31/plugins/tsa-skills-rank
npm install
npm run build
npm run smoke   # → [smoke] OK — todos os 8 testes passaram
```

## Como deployar (producao)

1. **Backup ativa:** se `/opt/openclaw-tsa-git/extensions/tsa-skills-rank`
   existe, mover pra `tsa-skills-rank.v0.1.0-bak/`.
2. **Copiar diretorio:** `rsync -a tsa-skills-rank/ /opt/openclaw-tsa-git/extensions/tsa-skills-rank/` (sem `_legacy-flat-format/`, `dist/`, `node_modules/`).
3. **Build no monorepo:** `cd /opt/openclaw-tsa-git && pnpm build` (a SDK
   workspace dep `@openclaw/plugin-sdk: workspace:*` resolve aqui).
4. **Manter `enabled: false`** no `openclaw.json` por 1 semana em
   homolog. Validar:
   - `tail -f ~/.openclaw/logs/*.log` sem erros referenciando
     `tsa-skills-rank`.
   - `sqlite3 ~/.openclaw/data/skills.sqlite "SELECT COUNT(*) FROM skills;"`
     bate com count de SKILL.md.
5. **Habilitar:** `enabled: true`, restart do agent, monitorar primeiros
   prompts pra confirmar que `appendSystemContext` chega no system prompt.

## Rollback

Se algo quebrar:

```bash
# Restaurar a versao 0.1.0 original byte-perfect
cd research/picks-v31/plugins/tsa-skills-rank
rm -rf src sql scripts package.json manifest.json DEPLOY.md openclaw.plugin.json index.ts types tsconfig.json
cp -r _legacy-flat-format/* .
npm install
npm test
```

Em producao, basta apontar `openclaw.json` de volta pra
`tsa-skills-rank.v0.1.0-bak/`.

## Checklist pos-merge

- [x] `_legacy-flat-format/` arquivado integralmente
- [x] `npm install` ok (sem deps SDK workspace que so existem em prod)
- [x] `npm run build` ok (tsc strict + NodeNext)
- [x] `npm run smoke` ok (8/8)
- [x] `openclaw.plugin.json` configSchema completo
- [x] `manifest.json` legado preservado com aviso
- [x] `scripts/index-skills.sh` aponta pro JS compilado
- [x] `MIGRATION-FLAT-TO-SDK.md` (este doc)
- [ ] Producao testada (NAO TOCA — Cadu vai validar)
