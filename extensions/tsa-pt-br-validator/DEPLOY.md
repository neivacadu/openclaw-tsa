# Deploy — tsa-pt-br-validator

## Estado

- `enabled: false` no `manifest.json` por padrao
- Modo `monitor` (so loga, nao bloqueia) ate 2026-05-05
- Threshold de score: `< 7` (de 0-10) gera evento
- Knowledge files: ja criados em `/home/ace-tsia/.openclaw/workspace/skills/0-revisao-pt-br/knowledge/`

## Pre-requisitos no clone

- Node 20+ (ja presente)
- Plugin runtime do OpenClaw aceitando hook `after_tool_call`
- Permissao de escrita em `/var/log/tsa-pt-br-validator.jsonl`

## Instalacao (passo a passo)

1. Build local:

   ```bash
   cd /Users/caduneiva2/Documents/TSA-ACE/research/picks-v31/plugins/tsa-pt-br-validator
   npm install
   npm run build
   npm test
   ```

2. Sync para tsa-llm:

   ```bash
   rsync -avz --exclude node_modules --exclude '.git' \
     /Users/caduneiva2/Documents/TSA-ACE/research/picks-v31/plugins/tsa-pt-br-validator/ \
     tsa-llm:/opt/tsa-ace-master/plugins/tsa-pt-br-validator/
   ```

3. Propagar pro clone:

   ```bash
   ssh tsa-llm 'rsync -av /opt/tsa-ace-master/plugins/tsa-pt-br-validator/ \
     /home/ace-tsia/.openclaw/plugins/tsa-pt-br-validator/ && \
     chown -R ace-tsia:ace-tsia /home/ace-tsia/.openclaw/plugins/tsa-pt-br-validator/ && \
     touch /var/log/tsa-pt-br-validator.jsonl && \
     chown ace-tsia /var/log/tsa-pt-br-validator.jsonl'
   ```

4. Registrar no `openclaw.json` do clone (campo `plugins.list`):

   ```json
   { "id": "tsa-pt-br-validator", "enabled": false }
   ```

   Manter `enabled: false` ate validacao da fase monitor.

5. Ativar fase MONITOR (Cadu autoriza):
   - Edita `manifest.json`: `"enabled": true`, `"mode": "monitor"`
   - Restart `ace-cadu-claw-telegram.service`

6. Ativar fase ENFORCEMENT (apos 7 dias monitor sem falsos positivos):
   - Edita `manifest.json`: `"mode": "enforcement"`
   - Restart servico
   - Cadu confirma antes (CONST-06, irreversivel pra agente em producao)

## Rollback

Editar `manifest.json` -> `"enabled": false` -> restart. 1 comando.

## Metricas a observar (fase monitor)

- Linhas em `/var/log/tsa-pt-br-validator.jsonl`
- Score medio por agente
- Top 10 issues
- Falsos positivos (texto bom marcado abaixo do threshold)

## Riscos

- Falso positivo em codigo/snippets: mitigado por `min_text_length` (200) + heuristica `looksLikePortuguese`
- Performance: regex sobre strings ate 4000 chars, custo ~ms — irrelevante
- Knowledge files ausentes: plugin retorna `allow` silencioso (defensivo)

## Validacao pos-deploy

```bash
ssh tsa-llm 'tail -f /var/log/tsa-pt-br-validator.jsonl'
```

Deve gerar eventos quando ACE/Joker/Hero gerar texto pt-BR > 200 chars.
