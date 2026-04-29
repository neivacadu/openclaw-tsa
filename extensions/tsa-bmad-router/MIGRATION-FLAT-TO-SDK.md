# MIGRATION — tsa-bmad-router · flat-format → SDK (`definePluginEntry`)

**Versão antes:** `tsa-bmad-router@0.1.0` (manifest.json + dist/index.js · padrão flat)
**Versão depois:** `@openclaw/tsa-bmad-router@0.2.0` (openclaw.plugin.json + index.ts top-level + `definePluginEntry` · padrão SDK)
**Referência seguida:** `/opt/openclaw-tsa-git/extensions/tsa-cascade-monitor` no fork OpenClaw 2026.4.26.
**Backup do legacy:** `_legacy-flat-format/` (manifest.json, package.json, package-lock.json, tsconfig.json, src/, DEPLOY.md). Restauração = copiar de volta + `rm -rf` do novo layout.

---

## Por que migrar

Plugins legacy do TSA carregavam via `manifest.json` plano (`exports.factory` + `hooks.<name>: <fnName>`). O fork OpenClaw 2026.4.25+ unificou pra **package SDK**: `package.json` declara `openclaw.extensions: ["./index.ts"]`, e o entry exporta `default definePluginEntry({ id, name, description, register })`. Vantagens:

- **Tipagem forte:** `OpenClawPluginApi` (logger, config, on()) — sem hook-name string solta.
- **Discovery automática:** harness varre `extensions/*/package.json` procurando `openclaw.extensions`. Não precisa registrar à mão em `openclaw.json` (a entry do clone só passa config).
- **Compat-gate:** `openclaw.compat.pluginApi: ">=2026.4.25"` falha na carga em fork antigo, sem rodar metade.
- **Mesmo perfil que `tsa-cascade-monitor`, `tsa-multi-persona-prompt`, `tsa-cascade-progress`** — paridade de manutenção, hot-reload e logs estruturados.

---

## Diff de superfície (alto nível)

| Aspecto           | Antes (flat)                                              | Depois (SDK)                                                                 |
| ----------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Nome do package   | `tsa-bmad-router`                                         | `@openclaw/tsa-bmad-router`                                                  |
| Versão            | `0.1.0`                                                   | `0.2.0`                                                                      |
| Module type       | CommonJS (default)                                        | `"type": "module"` (ESM, NodeNext)                                           |
| Entry declaration | `manifest.json` raiz + `dist/index.js`                    | `package.json#openclaw.extensions: ["./index.ts"]` + `openclaw.plugin.json`  |
| Entry shape       | `export function register(api) { api.registerHook(...) }` | `export default definePluginEntry({ id, name, description, register })`      |
| Hook name         | `before_subagent_spawn` (legacy)                          | `subagent_spawning` (canônico SDK · igual cascade-monitor/cascade-progress)  |
| API surface       | `api.registerHook(name, fn)`                              | `api.on<TEvent, TCtx>(name, handler)` + `api.logger.{info,warn,error}`       |
| Config schema     | embutido em `manifest.json#config` (sem validação)        | `openclaw.plugin.json#configSchema` (JSON-Schema, validado no load)          |
| Build target      | `module: CommonJS, target: ES2022`                        | `module: NodeNext, target: ES2022`                                           |
| Test runner       | `npm test` -> `dist/smoke.test.js`                        | `npm run smoke` -> `dist/src/smoke.test.js`                                  |
| Phases canônicas  | `discovery / architecture / implementation / review`      | `1-analysis / 2-plan-workflows / 3-solutioning / 4-implementation` (BMAD v6) |
| Logger            | injetado via `register(api).log` opcional                 | `api.logger.info(...)` sempre disponível                                     |

LÓGICA preservada 1:1: `BmadRouter` class, `classifyComplexity` (keywords +2 / stakeholders +1 / multi-step +1 / long +1, banda >=3), `pickPersona` com fallback walk pelo `phaseSequence`, `injectPersonaFlag` via `systemPromptPrepend`, `phase-hint` via `metadata.bmad.nextPhase`, defaults (complexityThreshold=3, monitorOnly:true, fallbackToVanillaJoker:true, longRequestThreshold=200, mesma lista de keywords PT/EN, mesmo regex multi-step).

---

## Estrutura de arquivos

**Antes (flat-format):**

```
tsa-bmad-router/
├── manifest.json
├── package.json                # name: tsa-bmad-router, main: dist/index.js
├── tsconfig.json               # module: CommonJS, rootDir: src
├── src/
│   ├── index.ts                # tudo num arquivo só (Router + register + factory)
│   └── smoke.test.ts
├── dist/                        # gerado
└── DEPLOY.md
```

**Depois (SDK-format):**

```
tsa-bmad-router/
├── package.json                # @openclaw/tsa-bmad-router · type:module · openclaw.extensions: ["./index.ts"]
├── openclaw.plugin.json        # id + configSchema (JSON-Schema)
├── tsconfig.json               # NodeNext + paths stub pra openclaw/plugin-sdk
├── index.ts                    # entry: definePluginEntry({ id, register })
├── src/
│   ├── plugin.ts               # BmadRouter + classifyComplexity + registerBmadRouter
│   └── smoke.test.ts           # imports './plugin.js' (NodeNext extension explicit)
├── types/
│   └── plugin-entry-stub.d.ts  # stub local pro standalone build (no monorepo, paths reais no tsconfig.package-boundary.paths.json)
├── dist/                        # gerado em dist/index.js + dist/src/plugin.js
├── DEPLOY.md
├── MIGRATION-FLAT-TO-SDK.md    # este arquivo
└── _legacy-flat-format/        # backup completo do antigo
```

---

## Build & test

**Standalone (research repo):**

```bash
cd /Users/caduneiva2/Documents/TSA-ACE/research/picks-v31/plugins/tsa-bmad-router
npm install
npm run build
npm run smoke    # esperado: 9 PASS + ALL SMOKE TESTS PASSED
```

**No fork OpenClaw (`/opt/openclaw-tsa-git/extensions/tsa-bmad-router`):**

- O monorepo já provê `@openclaw/plugin-sdk` via `tsconfig.package-boundary.paths.json` — o stub local em `types/` não é usado lá (path resolution prefere o real).
- Build acompanha o do monorepo: `pnpm -F @openclaw/tsa-bmad-router build` ou `npm run build` na pasta.
- Sem novas dependências externas (POL-OPS-06).

---

## Mudanças de comportamento

1. **Hook renomeado** `before_subagent_spawn` -> `subagent_spawning` (canônico SDK). Função: idêntica — dispara antes do spawn de subagente; mutações em `event.args` propagam pra harness.
2. **Phase names canônicos BMAD v6.** Configs com `phaseSequence: ["discovery", ...]` PRECISAM ser regravadas em `openclaw.json` pros novos slugs (`1-analysis`, `2-plan-workflows`, `3-solutioning`, `4-implementation`). Persona files no workspace `_bmad/core/agents/*.md` continuam com os mesmos slugs (mary-analyst.md, winston-architect.md etc.) — só o **nome da fase** mudou.
3. **`pickPhase` regex atualizado** pra mapear keywords nas novas fases:
   - `arquitetura|redesign|design|estrutura` -> `3-solutioning` (era `architecture`)
   - `plano|roadmap|workflow` -> `2-plan-workflows` (NOVO — fase planejamento explícita)
   - `implemente|deploy|build` -> `4-implementation` (era `implementation`)
   - `review|valide|qa` -> `4-implementation` (review absorvido na fase de implementação · sem persona-file separado)
   - default: `1-analysis` (era `discovery`)
4. **Default `personaMapping` redistribuído.** Mesmas 8 personas, novas buckets:
   - `1-analysis`: `[mary-analyst, james-strategist]`
   - `2-plan-workflows`: `[sophia-designer, james-strategist]`
   - `3-solutioning`: `[winston-architect, sophia-designer]`
   - `4-implementation`: `[carlos-impl, diana-builder, liam-reviewer, olivia-qa]`
5. **`phase-hint` aceita só os novos slugs.** Cascadas em flight com `metadata.bmad.nextPhase: "discovery"` viram **no-op** (não cai no readPhaseHint, mas a request continua roteada pela classificação normal). Mitigação: drenar conversas em flight antes do swap; aceitável porque o plugin estava em monitor-only.
6. **Fail-open envelope no register.** Qualquer exceção dentro do hook handler vira `api.logger.warn` + bypass — antes, exception propagava pro harness. Mais seguro pra produção.

---

## Rollout (zero-downtime, lab-first)

1. **Lab `ace-tsia-beta`.** Constitution #6 NÃO bloqueia. Default ship `enabled:false` + `monitorOnly:true`.
2. Copiar `tsa-bmad-router/` (sem `_legacy-flat-format/`, sem `node_modules/`) pra `/opt/openclaw-tsa-git/extensions/`. Build dentro do monorepo.
3. Editar `openclaw.json` em `ace-tsia-beta` — REMOVER entry antiga `tsa-bmad-router` (manifest.json-style) e ADICIONAR a nova:
   ```json
   {
     "id": "tsa-bmad-router",
     "enabled": false,
     "config": {
       "complexityThreshold": 3,
       "bmadPersonasDir": "/home/ace-tsia/.openclaw/workspace/_bmad/core/agents",
       "monitorOnly": true,
       "logDecisions": true,
       "fallbackToVanillaJoker": true
     }
   }
   ```
4. `systemctl restart openclaw@ace-tsia-beta`. Tail logs:
   ```bash
   journalctl -fu openclaw@ace-tsia-beta | grep "tsa-bmad-router"
   ```
   Esperado: linha `tsa-bmad-router SHADOW {...}` em conversa real, sem mutação de spawn args.
5. **1 semana shadow** -> calibrar threshold/keywords -> `monitorOnly:false` em canary 24h -> rollout fleet (5 por vez · staggered 30s).
6. **Rollback:** `enabled:false` + restart. OU restaurar `_legacy-flat-format/` + remover novos arquivos top-level.

---

## Riscos conhecidos / pendências

- **Stub local de types** (`types/plugin-entry-stub.d.ts`) cobre só o subset usado neste plugin. Se a SDK adicionar campos no `OpenClawPluginApi` que esse plugin precise, atualizar o stub. No monorepo isso é não-issue (path real ganha).
- **`event.args` shape em `subagent_spawning`** depende do harness. O register tenta ler de `event.args.agent` e `event.args.request`; se o harness emitir formato diferente (ex: `event.subagent.id`), ajustar o `agentId` lookup. Hoje seguimos o mesmo formato que `tsa-cascade-monitor` usa pra `event.agentId`.
- **Persona files MD** ainda referenciam `_bmad/core/agents/<slug>.md`. Se renomearem pra incluir prefixo de fase (`1-analysis-mary.md`), atualizar `personaMapping`.
- **`tsa-multi-persona-prompt` ordering** — antes da migração havia `manifest.ordering.before: ["tsa-multi-persona-prompt"]`. No formato SDK não há campo equivalente; ordering passa a ser enforced pelo harness baseado em `package.json#openclaw.priority` ou ordem de discovery. Hoje cascade-monitor não declara prioridade e funciona — assumimos paridade. Se notar race com multi-persona-prompt, adicionar `openclaw.priority: <num>` (lower = earlier).
- **Diff de fases na config legada** (passo 5 de "Mudanças de comportamento"): garantir que clones em produção não tenham `phaseSequence` ou `personaMapping` customizados com nomes antigos antes do restart.

---

## Smoke offline — saída esperada

```
> @openclaw/tsa-bmad-router@0.2.0 smoke
> node --enable-source-maps dist/src/smoke.test.js

PASS 1-trivial (complexity=1, applied=vanilla_joker)
PASS 2-strategy (phase=3-solutioning, persona=winston-architect)
PASS 3-arch (persona=winston-architect)
PASS 4-shadow (would-inject=sophia-designer, args clean)
PASS 5-bypass (target=0-hero passes through)
PASS 6-fallback (resolved=winston-architect)
PASS 7-classify (single keyword -> 2)
PASS 8-hint (phase hint honored: carlos-impl)
PASS 9-factory (createBmadRouter -> mary-analyst)

ALL SMOKE TESTS PASSED
```

Build clean (`tsc` exit 0). Zero warning, zero deps externos novos.
