# DEPLOY — tsa-skills-rank

> **Banco mantem TODAS as 1.424 skills.** Rank decide top N pro system prompt; resto fica invocavel via `skill_search` + `skill_invoke`. Cadu confirmou: NAO cortar skills.

## TL;DR

| Item              | Valor                                                         |
| ----------------- | ------------------------------------------------------------- |
| Plugin            | `tsa-skills-rank` v0.1.0                                      |
| Tier              | Camada 4 / Core                                               |
| `enabled` default | `false` (ligar manual em homolog primeiro)                    |
| Banco             | SQLite WAL em `/home/ace-tsia/.openclaw/data/skills.sqlite`   |
| Workspace lido    | `/home/ace-tsia/.openclaw/workspace/skills` (somente leitura) |
| Hooks             | `before_prompt_build`, `after_tool_call`                      |
| Tools expostas    | `skill_search(query, limit)`                                  |
| Top N default     | 50                                                            |
| Score             | FTS5 0.4 + uso_recente 0.3 + success 0.2 + categoria 0.1      |
| Roadmap V2        | Trocar FTS5 por pgvector quando Camada 4 (pgvector) subir     |

---

## Pre-requisitos

- OpenClaw fork TSA >= 4.24
- Node >= 20 (ace-tsia ja roda 20)
- Postgres / SQLite ja vivem na VPS — usamos SQLite local
- `better-sqlite3` compila nativo: `apt install -y build-essential python3` se fork minimo
- Pushgateway opcional em `localhost:9091` (sistema TSA ja tem)

## Instalacao

```bash
# 1. Copiar plugin pro destino padrao
sudo -u ace-tsia cp -r /tmp/tsa-skills-rank /opt/openclaw/plugins/

# 2. Instalar deps (compila better-sqlite3 nativo)
cd /opt/openclaw/plugins/tsa-skills-rank
sudo -u ace-tsia npm install --omit=dev

# 3. Criar dir de dados se nao existir
sudo -u ace-tsia mkdir -p /home/ace-tsia/.openclaw/data
sudo chown ace-tsia:ace-tsia /home/ace-tsia/.openclaw/data
```

## Indexacao inicial (one-shot, antes de habilitar)

```bash
# Como ace-tsia, rodar indexacao inicial
sudo -u ace-tsia bash /opt/openclaw/plugins/tsa-skills-rank/scripts/index-skills.sh

# Validar contagem
sudo -u ace-tsia sqlite3 /home/ace-tsia/.openclaw/data/skills.sqlite \
  'SELECT COUNT(*) AS total, COUNT(DISTINCT category) AS cats FROM skills;'
# esperado: total=1424 (ou proximo, dependendo do estado atual do workspace), cats >= 5

# Sanity check FTS5
sudo -u ace-tsia sqlite3 /home/ace-tsia/.openclaw/data/skills.sqlite \
  "SELECT skill_id FROM skills_fts WHERE skills_fts MATCH 'landing*' LIMIT 5;"
```

## Smoke test (em /tmp, NAO toca producao)

```bash
cd /opt/openclaw/plugins/tsa-skills-rank
sudo -u ace-tsia npx tsx src/smoke.test.ts
# esperado: '[smoke] OK — todos os 7 testes passaram'
```

## Habilitar em **homolog** (clone ace-tsia-beta)

1. Editar `/home/ace-tsia/.openclaw/config/openclaw.config.json`:

```json
{
  "plugins": {
    "tsa-skills-rank": {
      "enabled": true,
      "config": {
        "topN": 50,
        "skillsDir": "/home/ace-tsia/.openclaw/workspace/skills",
        "dbPath": "/home/ace-tsia/.openclaw/data/skills.sqlite"
      }
    }
  }
}
```

2. Reiniciar agente:

```bash
sudo systemctl restart openclaw@ace-tsia-beta.service
```

3. Validar no log:

```bash
sudo journalctl -u openclaw@ace-tsia-beta -n 200 --no-pager | grep -i "skills-rank\|skillsSnapshot"
# esperado: linha confirmando snapshot injetado com top 50
```

4. Validar via Telegram: mandar mensagem "criar landing page" e checar se ace cita skill correta no plano.

## Cron de re-indexacao

```bash
# Adicionar em /etc/cron.d/tsa-skills-rank-index
echo '0 4 * * * ace-tsia /opt/openclaw/plugins/tsa-skills-rank/scripts/index-skills.sh >>/var/log/tsa/skills-rank-cron.log 2>&1' \
  | sudo tee /etc/cron.d/tsa-skills-rank-index
sudo chmod 644 /etc/cron.d/tsa-skills-rank-index
```

Re-roda 04:00 diario, captura skills novas + remove deletadas.

## Producao (rollout em batches)

> NAO LIGAR EM TODOS OS 50 CLONES DE UMA VEZ.

Estrategia:

1. Homolog (ace-tsia-beta) — 24h observacao
2. Batch 1: 5 clones — 48h observacao
3. Batch 2: 20 clones
4. Batch 3: restante

Rollback: setar `enabled: false` no config + restart. Banco fica intacto, sem efeito colateral.

## Metricas

Pushgateway endpoints:

- `tsa_skills_rank_query_total{result="ok|error|empty"}`
- `tsa_skills_indexed_total` (gauge)
- `tsa_skill_invocations_total{skill_id}`

Painel Grafana sugerido:

- Total skills no banco (gauge) — alerta se cair >5% entre indexacoes
- p50/p95 tempo de rank() — alerta p95 > 50ms
- Top 20 skills mais invocadas (24h)
- % queries com result=empty — alerta > 30%

## Validacoes obrigatorias antes de marcar done

- [ ] Smoke test passa (7/7)
- [ ] DB indexado com >= 1.000 skills em homolog
- [ ] Snapshot do system prompt mostra top 50 com **descriptions completas** (nao so nomes)
- [ ] Tool `skill_search` responde em < 30ms p95
- [ ] Hook `after_tool_call` registrando invocacoes (checar `skill_invocations` count > 0 apos uso)
- [ ] Cron rodou ao menos 1 vez sem erro
- [ ] Metricas chegando no pushgateway

## Troubleshooting

**`better-sqlite3` falha install**

```bash
apt install -y build-essential python3
npm rebuild better-sqlite3
```

**FTS5 retorna 0 resultados pra qualquer query**

- Verificar se triggers de sync existem: `.schema skills_fts`
- Re-popular: `INSERT INTO skills_fts(skills_fts) VALUES('rebuild');`

**Snapshot vazio no system prompt**

- Conferir `enabled: true` no config
- Conferir hook ordering: `before_prompt_build` priority 50 nao deve estar suprimido por outro plugin
- Log: `journalctl -u openclaw@<clone> | grep -i skillsSnapshot`

**Banco cresce demais (`rank_cache`)**

```sql
DELETE FROM rank_cache WHERE created_at < datetime('now', '-1 day');
VACUUM;
```

Cron sugerido: limpar cache > 1 dia, semanal.

## Roadmap V2 (pos Camada 4 pgvector online)

| Feature              | V1                 | V2                                              |
| -------------------- | ------------------ | ----------------------------------------------- |
| Texto match          | FTS5 SQLite        | pgvector cosine similarity                      |
| Embedding            | placeholder `BLOB` | `vector(1536)` Postgres                         |
| Categoria            | heuristica keyword | semantic clustering                             |
| Cross-clone learning | local-only         | aggregate uso entre clones via pgvector central |
| Latency              | < 30ms             | ~50-80ms (network hop)                          |

Migracao V1 → V2: rodar pgvector ao lado, comparar rank quality 7 dias, swap.

## Aderencia constitution

- **R-005** (no API key) — usa OAuth/local-only, sem providers externos
- **R-021** (no touch producao sem aprovacao) — `enabled:false` default + rollout em batches
- **R-077** (skills sao SoT no filesystem) — banco e cache, fonte e workspace/skills
