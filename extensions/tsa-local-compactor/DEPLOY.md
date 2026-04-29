# DEPLOY — tsa-local-compactor (Pick A3)

**Status:** plugin pronto, **NÃO deployar em produção sem canary**.
**Default:** `enabled: false` no `manifest.json`. Ativação canary em 1 bot (ace-tsia-beta) por 24h antes de rollout.

## 0. Pré-requisitos

- Acesso a `master.tsa` (host do fork OpenClaw `/opt/openclaw-tsa-git`).
- OAuth Claude CLI ativo no clone alvo.
- Backup do `openclaw.json` ANTES de editar (`cp openclaw.json openclaw.json.bak.$(date +%s)`).

## 1. Copiar plugin pro fork

```bash
# Do Mac, mandar pra master.tsa via scp ou rsync.
rsync -av \
  /Users/caduneiva2/Documents/TSA-ACE/research/picks-v31/plugins/tsa-local-compactor/ \
  master.tsa:/tmp/tsa-local-compactor/

# Em master.tsa:
ssh master.tsa
sudo cp -r /tmp/tsa-local-compactor /opt/openclaw-tsa-git/extensions/
sudo chown -R ace-tsia:ace-tsia /opt/openclaw-tsa-git/extensions/tsa-local-compactor
```

## 2. Build local do plugin

```bash
cd /opt/openclaw-tsa-git/extensions/tsa-local-compactor
sudo -u ace-tsia npm install
sudo -u ace-tsia npm run build
sudo -u ace-tsia npm test    # smoke offline, NÃO toca runtime
```

`npm test` deve imprimir 4 PASS + `ALL SMOKE TESTS PASSED`. Se falhar, **abortar deploy**.

## 3. Registrar no openclaw.json

Editar `/home/ace-tsia/.openclaw/openclaw.json`, adicionar entry em `plugins.entries`:

```jsonc
{
  "plugins": {
    "entries": [
      // ...entries existentes...
      {
        "id": "tsa-local-compactor",
        "path": "/opt/openclaw-tsa-git/extensions/tsa-local-compactor",
        "enabled": false,
        "config": {
          "preserveRecent": 8,
          "maxTokens": 15000,
          "compactTarget": 6000,
          "mode": "heuristic",
          "logBeforeAfter": true,
        },
      },
    ],
  },
}
```

`enabled: false` é proposital — primeiro deploy só carrega o código, não ativa hook.

## 4. Restart do clone alvo (ace-tsia-beta)

```bash
sudo systemctl restart openclaw@ace-tsia-beta
sudo journalctl -u openclaw@ace-tsia-beta -n 100 --no-pager | grep -i compactor
```

Esperado: log de plugin carregado, **sem** linha `compactor: in=...` (porque enabled=false).

## 5. Canary (1 bot, 24h)

Trocar `"enabled": false` → `"enabled": true` apenas no clone `ace-tsia-beta`. Restart. Observar:

- `journalctl -fu openclaw@ace-tsia-beta | grep compactor` — esperar linhas `compactor: in=NK msgs=M out=N'K saved=ΔK`.
- Sanidade nas conversas Telegram do bot — sem perda de contexto óbvia, sem alucinação por sumário ruim.
- 24h mínimo antes de avaliar rollout.

## 6. Rollout 52 bots

Após canary OK por 24h, ativar `enabled: true` nos 52 clones. Restart staggered (5 por vez, 30s gap) pra não tombar todos.

## 7. ROLLBACK (qualquer hora)

Se aparecer comportamento estranho (perda de memória, sumário corrompido, latência):

```bash
# Editar openclaw.json no clone afetado
# Trocar "enabled": true → "enabled": false na entry tsa-local-compactor
sudo systemctl restart openclaw@<clone-name>
```

Rollback é **instantâneo** — plugin desativado não modifica `messages[]`. Em emergência, restaurar `openclaw.json.bak.<timestamp>` e restart.

## 8. Métricas (futuro — A12 cost hook integration)

Prometheus scrape esperado em `/metrics`:

```
tsa_compactor_runs_total{result="ok",hook="before_prompt_build"} N
tsa_compactor_tokens_saved_bucket{le="..."}
tsa_compactor_duration_ms_bucket{le="..."}
```

Endpoint exporter ainda **não implementado** nesta versão 0.1.0 — apenas log estruturado em stdout via `logBeforeAfter: true`. Parsear journalctl pra dashboard inicial.

## 9. Notas

- **Zero LLM** no caminho quente — heurística pura, dependências zero (apenas tipos TS).
- Ordem de hooks no fork: `before_prompt_build` (este) → provider call → `before_tool_call` (A12 budget gate). Compactor reduz tokens **antes** do gate ler.
- Default `mode: "heuristic"`. Para desabilitar sem alterar manifest, setar `"mode": "off"` no config — equivale a no-op.
- Lab oficial: `ace-tsia-beta`. Constitution #6 NÃO bloqueia teste neste clone.
