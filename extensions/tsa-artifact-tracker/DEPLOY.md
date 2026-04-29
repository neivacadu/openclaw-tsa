# tsa-artifact-tracker — DEPLOY

Auto-rastreador de artefatos (HTML, PDF, MD, imagens, código...) gerados por
`Write` / `Edit` / `Bash`. Indexa em SQLite + FTS5 e expõe 4 tools que o Ace
chama para "lembrar" o que foi criado em sessões anteriores.

> **Status**: `enabled: false` por default no `manifest.json`. Habilitar
> manualmente após smoke + 24h de validação no clone-piloto.

---

## 1. Instalação (clone alvo)

```bash
# 1.1 Copiar o plugin
sudo -u ace-tsia mkdir -p /opt/openclaw-tsa-git/plugins/tsa-artifact-tracker
sudo -u ace-tsia rsync -a /tmp/tsa-artifact-tracker/ \
  /opt/openclaw-tsa-git/plugins/tsa-artifact-tracker/

# 1.2 Build
cd /opt/openclaw-tsa-git/plugins/tsa-artifact-tracker
sudo -u ace-tsia npm install
sudo -u ace-tsia npm run build

# 1.3 Smoke (usa /tmp, NÃO toca produção)
sudo -u ace-tsia npm run smoke
```

Esperado: `ALL SMOKE OK`. Se falhar, NÃO habilitar.

---

## 2. Schema SQLite

A primeira execução do hook cria `/home/ace-tsia/.openclaw/data/artifacts.sqlite`
e aplica `sql/schema.sql` (idempotente — `CREATE ... IF NOT EXISTS`).

Para inspecionar:

```bash
sudo -u ace-tsia sqlite3 /home/ace-tsia/.openclaw/data/artifacts.sqlite \
  '.schema artifacts'
sudo -u ace-tsia sqlite3 /home/ace-tsia/.openclaw/data/artifacts.sqlite \
  'SELECT kind, COUNT(*) FROM artifacts GROUP BY kind;'
```

---

## 3. Habilitar no clone

Em `/opt/openclaw-tsa-git/plugins/tsa-artifact-tracker/manifest.json` mudar:

```diff
- "enabled": false,
+ "enabled": true,
```

E ajustar `config.publicUrlMappings` se o clone publica em domínio diferente
de `ace.caduneiva.com`. **Não tocar em outros plugins.**

Recarregar:

```bash
sudo systemctl reload openclaw@ace-tsia
# ou, se o clone não suporta reload limpo:
sudo systemctl restart openclaw@ace-tsia
```

---

## 4. Validação pós-deploy (5 min)

1. Mandar pro Ace: `gere /tmp/test-tracker.html com "<h1>ok</h1>"`.
2. Conferir no DB:
   ```bash
   sudo -u ace-tsia sqlite3 /home/ace-tsia/.openclaw/data/artifacts.sqlite \
     "SELECT path, kind, status FROM artifacts WHERE path='/tmp/test-tracker.html';"
   ```
   (Deve aparecer; mas **note**: `/tmp/` está em `ignorePaths` no manifest
   default; pra validação use `/var/www/ace/test-tracker.html` ou ajuste
   `ignorePaths` temporariamente.)
3. Mandar pro Ace: `o que você gerou nas últimas 24h?` → deve chamar
   `artifacts_recent` e listar.
4. Limpar: `rm /var/www/ace/test-tracker.html` + `UPDATE artifacts SET status='deleted' WHERE ...`.

---

## 5. Métricas Prometheus

Expor via `/metrics` do agente principal (já tem o coletor TSA-native):

| Métrica                        | Tipo    | Labels   |
| ------------------------------ | ------- | -------- |
| `tsa_artifacts_tracked_total`  | counter | `kind`   |
| `tsa_artifacts_searches_total` | counter | —        |
| `tsa_artifacts_total`          | gauge   | `status` |

`ArtifactTracker.metrics()` retorna um snapshot pronto para scrape.

Alertas sugeridos (Camada 6):

- `rate(tsa_artifacts_tracked_total[1h]) == 0` por > 6h em horário comercial
  → hook silenciosamente quebrado.
- `tsa_artifacts_total{status="active"} > 50_000` → revisar `ignorePaths` /
  rodar limpeza de `/tmp/`-likes acidentais.

---

## 6. Rollback

```bash
# Desabilitar sem perder dados
sudo -u ace-tsia jq '.enabled = false' \
  /opt/openclaw-tsa-git/plugins/tsa-artifact-tracker/manifest.json > /tmp/m.json
sudo -u ace-tsia mv /tmp/m.json \
  /opt/openclaw-tsa-git/plugins/tsa-artifact-tracker/manifest.json
sudo systemctl reload openclaw@ace-tsia

# Wipe completo (DESTRUTIVO — só se Cadu autorizar)
sudo -u ace-tsia rm /home/ace-tsia/.openclaw/data/artifacts.sqlite
```

---

## 7. Limites conhecidos

- **Heurística de path**: regex `wrote /path` + Bash redirect cobre ~90% mas
  não 100%. Comandos como `python -c 'open(...).write(...)'` passam batido.
  Fix futuro: hook adicional em níveis de filesystem (inotify) — fora do P1.
- **`content_hash`**: lido sincronamente do disco. Para arquivos > 50MB
  considera-se `null` (ainda não implementado o curto-circuito; ver TODO).
- **`prompt_summary`** depende do harness passar contexto da sessão; se o
  OpenClaw não fornecer, fica `NULL` e a busca FTS perde recall semântico.
