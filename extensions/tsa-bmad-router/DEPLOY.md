# DEPLOY — tsa-bmad-router (Pick P1-C)

**Status:** plugin pronto, **NÃO deployar em produção sem canary**.
**Default:** `enabled: false` + `monitorOnly: true` no `manifest.json`.
Primeira semana só observa; só depois liga enforcement em ace-tsia-beta.

## Spec resumida

Hook `before_subagent_spawn` (target = `0-joker`):

1. Classifica complexidade da request (1=trivial, 2=média, 3=complexa).
2. Se `complexity >= complexityThreshold` (default 3): escolhe fase BMAD e persona compatível, injeta no `systemPromptPrepend` do JOKER ("você está operando como mary-analyst (fase: discovery), carregue `_bmad/core/agents/mary-analyst.md`...").
3. Se abaixo do threshold: vanilla JOKER, sem mexer.
4. Phase hint via `metadata.bmad.nextPhase` permite cascades subsequentes pular a classificação e usar a fase certa.

Heurística de complexidade (sem LLM):

| sinal                                                  | peso |
| ------------------------------------------------------ | ---: |
| keyword complexa (estrategia/arquitetura/redesign/...) |   +2 |
| stakeholders (diretoria, clientes, ...)                |   +1 |
| multi-step ("primeiro X, depois Y, então Z")           |   +1 |
| request longa (>200 chars)                             |   +1 |

Bandas: `score >= 3 -> 3`, `score >= 1 -> 2`, senão `1`.

## 0. Pré-requisitos

- Acesso a `master.tsa` (host do fork OpenClaw `/opt/openclaw-tsa-git`).
- Personas BMAD presentes em `/home/ace-tsia/.openclaw/workspace/_bmad/core/agents/*.md` (Mary, James, Winston, Sophia, Carlos, Diana, Liam, Olivia). Validar com `ls`.
- Backup do `openclaw.json` ANTES de editar (`cp openclaw.json openclaw.json.bak.$(date +%s)`).
- Plugin `tsa-multi-persona-prompt` carregado (este plugin é "before" dele — escolhe a persona, multi-persona-prompt aplica o overlay).

## 1. Copiar plugin pro fork

```bash
# Do Mac, mandar pra master.tsa via rsync.
rsync -av \
  /Users/caduneiva2/Documents/TSA-ACE/research/picks-v31/plugins/tsa-bmad-router/ \
  master.tsa:/tmp/tsa-bmad-router/

# Em master.tsa:
ssh master.tsa
sudo cp -r /tmp/tsa-bmad-router /opt/openclaw-tsa-git/extensions/
sudo chown -R ace-tsia:ace-tsia /opt/openclaw-tsa-git/extensions/tsa-bmad-router
```

## 2. Build local do plugin

```bash
cd /opt/openclaw-tsa-git/extensions/tsa-bmad-router
sudo -u ace-tsia npm install
sudo -u ace-tsia npm run build
sudo -u ace-tsia npm test    # smoke offline, NÃO toca runtime
```

`npm test` deve imprimir 9 PASS + `ALL SMOKE TESTS PASSED`. Se falhar, **abortar deploy**.

## 3. Validar personas no workspace

```bash
ls /home/ace-tsia/.openclaw/workspace/_bmad/core/agents/
# Esperado: mary-analyst.md  james-strategist.md  winston-architect.md
#           sophia-designer.md  carlos-impl.md  diana-builder.md
#           liam-reviewer.md  olivia-qa.md
```

Se algum slug estiver com nome diferente (ex: persona MD usa `analyst.md` e não `mary-analyst.md`), ajustar `personaMapping` no manifest **antes** de carregar — senão `pickPersona` cai em fallback.

## 4. Registrar no openclaw.json

Editar `/home/ace-tsia/.openclaw/openclaw.json`, adicionar entry em `plugins.entries`:

```jsonc
{
  "plugins": {
    "entries": [
      // ...entries existentes...
      {
        "id": "tsa-bmad-router",
        "path": "/opt/openclaw-tsa-git/extensions/tsa-bmad-router",
        "enabled": false,
        "config": {
          "complexityThreshold": 3,
          "bmadPersonasDir": "/home/ace-tsia/.openclaw/workspace/_bmad/core/agents",
          "monitorOnly": true,
          "logDecisions": true,
          "fallbackToVanillaJoker": true,
        },
      },
    ],
  },
}
```

`enabled: false` + `monitorOnly: true` é proposital — primeiro deploy só carrega o código, não ativa hook.

## 5. Restart do clone alvo (ace-tsia-beta) — modo monitor

```bash
# Trocar enabled: false -> true mas DEIXAR monitorOnly: true
sudo systemctl restart openclaw@ace-tsia-beta
sudo journalctl -fu openclaw@ace-tsia-beta | grep "tsa-bmad-router"
```

Esperado durante 1 semana: linhas `[tsa-bmad-router] SHADOW {...persona:"X",...applied:"shadow_persona_injected_monitor_only"}` em conversas reais. **Nenhuma** mutação em spawn args — JOKER continua vanilla.

## 6. Calibração (1 semana)

Coletar amostra:

```bash
journalctl -u openclaw@ace-tsia-beta --since "7 days ago" | grep "tsa-bmad-router" | wc -l
journalctl -u openclaw@ace-tsia-beta --since "7 days ago" | grep '"applied":"shadow_persona_injected_monitor_only"' | wc -l
journalctl -u openclaw@ace-tsia-beta --since "7 days ago" | grep '"applied":"vanilla_joker"' | wc -l
```

Métricas-alvo:

- ≥10% de cascades classificadas como complexity=3 (signal saudável que threshold não está alto demais)
- ≤30% (threshold não está baixo demais — não é pra todo "oi" virar BMAD)
- Distribuição de personas razoável (não 100% Mary)

Se a heurística estiver classificando errado (request curta mas complexa, ou longa mas trivial): ajustar `complexKeywords`, `longRequestThreshold` ou `complexityThreshold` ANTES de ligar enforcement.

## 7. Enforcement — canary (24h)

Após 1 semana de monitor saudável:

```jsonc
"config": {
  ...
  "monitorOnly": false   // <-- liga
}
```

Restart `ace-tsia-beta`. Observar:

- Logs viram `[tsa-bmad-router] inject {...applied:"persona_injected"}`
- Sanidade nas conversas Telegram do bot — JOKER de fato carrega persona MD na primeira fala
- 24h mínimo antes de avaliar rollout

## 8. Rollout fleet (52 bots)

Após canary OK por 24h: ligar nos 52 clones com `enabled: true` + `monitorOnly: false`. Restart staggered (5 por vez, 30s gap) pra não tombar todos.

## 9. ROLLBACK (qualquer hora)

Se aparecer comportamento estranho (JOKER alucina persona, prepend muito grande, latência):

```bash
# Editar openclaw.json no clone afetado
# Trocar "enabled": true -> "enabled": false na entry tsa-bmad-router
sudo systemctl restart openclaw@<clone-name>
```

Rollback é **instantâneo** — plugin desativado não modifica spawn args. Em emergência, restaurar `openclaw.json.bak.<timestamp>` e restart.

Rollback parcial sem restart: trocar `monitorOnly` pra `true` — hook continua rodando mas vira no-op. Próximo restart aplica config; em alguns harness builds o hot-reload pega a mudança sem restart.

## 10. Métricas Prometheus (futuro — A12 cost hook integration)

Endpoint exporter ainda **não implementado** nesta versão 0.1.0 — apenas log estruturado em stdout via `logDecisions: true`. Parsear journalctl pra dashboard inicial.

Métricas planejadas pra v0.2.0:

```
tsa_bmad_router_decisions_total{client="...",applied="vanilla_joker|persona_injected|shadow_*"} N
tsa_bmad_router_complexity_bucket{le="1|2|3"} N
tsa_bmad_router_phase_total{phase="discovery|architecture|implementation|review"} N
tsa_bmad_router_persona_total{persona="mary-analyst|..."} N
tsa_bmad_router_decision_duration_ms_bucket{le="..."} N
```

Janela de scrape: 60s (idêntico aos outros plugins TSA).

## 11. Trade-offs e limitações conhecidas

- **Heurística pode classificar mal.** Request curta mas profunda ("redesign?") sai como complexity=2 e pula BMAD; request longa mas vazia ("blá blá blá... resuma") sai como 2 sem necessidade. Calibragem na semana monitor mitiga, não elimina.
- **Solução V2 conhecida**: HUNTER (Sonnet) pré-classifica antes do JOKER. Custo: +1 chamada LLM por turn. Decisão: começar V1 zero-LLM, só evoluir se monitor mostrar miss-rate >25%.
- **Persona file ausente** ⇒ fallback walk pelo `phaseSequence`. Se TUDO falhar: vanilla JOKER (preserva operação). Log estruturado avisa qual slug não resolveu.
- **Phase hint contínuo**: cada cascade pode escolher a próxima persona via `metadata.bmad.nextPhase`. JOKER precisa ser instruído (no system prompt prepend) a cuspir essa hint no rodapé. Se ele não cuspir, a cascade seguinte volta pra discovery — não trava, só perde o estado de máquina.
- **Conflito com tsa-multi-persona-prompt**: este plugin escolhe a persona; aquele aplica overlay no prompt. Ordering em manifest (`before: ["tsa-multi-persona-prompt"]`) garante que o systemPromptPrepend já chegue setado quando o multi-persona vai ler. Se o sibling não estiver carregado, JOKER ainda recebe o prepend cru — funciona, só perde a integração rica de papéis.
- **Idempotência**: re-run com mesmos args produz mesma decision. Mas se `injectPersonaFlag` rodar 2x acumula prepends (uso de `+=`). Em rollback de erro mid-flight, harness deve limpar `systemPromptPrepend` antes de re-tentar.

## 12. Notas

- **Zero LLM** no caminho quente — heurística pura + fs check (cache em memória).
- **Lab oficial**: `ace-tsia-beta`. Constitution #6 NÃO bloqueia teste neste clone.
- Default `monitorOnly: true` é a regra. Só liga enforcement depois de ≥1 semana de log validation.
- Plugin alinhado à v1.1: persona-flag dentro do JOKER (multi-persona em 1 LLM), zero touch core do OpenClaw.
