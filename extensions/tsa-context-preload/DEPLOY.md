# Deploy — `tsa-context-preload` (P0-A)

Heuristic context recall plugin para Ace-TSIA. Lê workspace/memory + artefatos +
tail da última session e injeta no system prompt no hook `before_prompt_build`.

## Por que existe

Bot Telegram do Ace-TSIA inicia cada session limpa. Usuário gera HTML em sessão
1; em sessão 2 o Ace não sabe que existe. Este plugin é o band-aid funcional
até a Camada 4 (pgvector / Pick P2-E v1.6) substituir com retrieval semântico.

## Trade-offs (assumidos)

- **HEURÍSTICO** — recall por mtime, não similaridade semântica. Pode trazer
  arquivos irrelevantes (o último .md tocado pode não ser o mais importante)
  ou perder coisas relevantes (memória de 4 dias atrás cai fora da janela).
- **Budget rígido 5K tokens** — corta por seção priorizando recência. Memórias
  vêm primeiro, depois artefatos, depois session tail. Se memórias estouram
  o budget, artefatos e tail ficam de fora.
- **Sem dedup** — pode injetar a mesma info que já está no system prompt do
  agente. Aceitável em P0-A, refinar com P2-E.

## Path no fork

```
/opt/openclaw-tsa-git/extensions/tsa-context-preload/
```

## Build offline (Mac, antes de subir)

```bash
cd /Users/caduneiva2/Documents/TSA-ACE/research/picks-v31/plugins/tsa-context-preload
npm install
npm run build
npm test                           # smoke verde antes de seguir
```

Esperado: 4 testes passando, dist/index.js gerado.

## Subir pro fork

```bash
ssh ace-tsia@tsa-master
sudo mkdir -p /opt/openclaw-tsa-git/extensions/tsa-context-preload
sudo rsync -a --delete \
  /tmp/tsa-context-preload/ \
  /opt/openclaw-tsa-git/extensions/tsa-context-preload/
cd /opt/openclaw-tsa-git/extensions/tsa-context-preload
sudo -u ace-tsia npm install
sudo -u ace-tsia npm run build
sudo -u ace-tsia npm test
```

## Registrar em `openclaw.json` (clone ace-tsia-beta)

Localização: `/home/ace-tsia/.openclaw/openclaw.json`

Adicionar em `plugins`:

```jsonc
{
  "tsa-context-preload": {
    "enabled": false,
    "priority": 5,
    "config": {
      "memoryDaysBack": 3,
      "artifactsHoursBack": 24,
      "lastSessionTurns": 20,
      "maxTokens": 5000,
      "memoryDir": "/home/ace-tsia/.openclaw/workspace/memory",
      "artifactsDirs": ["/home/ace-tsia/.openclaw/workspace"],
      "artifactExtensions": ["html", "pdf", "doc", "docx", "md", "png", "jpg", "jpeg"],
      "publicUrlPrefix": "https://ace.caduneiva.com/",
      "publicUrlBasePath": "/var/www/ace/",
      "sessionsDir": "/home/ace-tsia/.openclaw/sessions",
      "agentsToInject": ["0-ace"],
    },
  },
}
```

`enabled:false` no primeiro deploy. Plugin fica registrado mas inerte.

## Smoke offline final no clone

```bash
sudo -u ace-tsia node -e "
  const { createContextPreload } = require('/opt/openclaw-tsa-git/extensions/tsa-context-preload/dist/index.js');
  const p = createContextPreload({
    memoryDaysBack:3, artifactsHoursBack:24, lastSessionTurns:20, maxTokens:5000,
    memoryDir:'/home/ace-tsia/.openclaw/workspace/memory',
    artifactsDirs:['/home/ace-tsia/.openclaw/workspace'],
    artifactExtensions:['html','pdf','md','png','jpg'],
    publicUrlPrefix:'https://ace.caduneiva.com/',
    publicUrlBasePath:'/var/www/ace/',
    sessionsDir:'/home/ace-tsia/.openclaw/sessions',
    agentsToInject:['0-ace']
  });
  p.loadContext({agentId:'0-ace'}).then(r => {
    console.log('META', JSON.stringify(r.metadata, null, 2));
    console.log('---');
    console.log(r.systemPromptAppend);
  });
"
```

Esperado: vê o bloco "## Contexto recuperado (auto)" com memórias do workspace
real, sem erro, `tokensInjected <= 5000`.

## Ativar (janela de manutenção)

Hook só registra em startup. Precisa restart.

```bash
sudo -u ace-tsia jq '.plugins["tsa-context-preload"].enabled = true' \
  /home/ace-tsia/.openclaw/openclaw.json > /tmp/oc.json && \
  sudo mv /tmp/oc.json /home/ace-tsia/.openclaw/openclaw.json && \
  sudo chown ace-tsia:ace-tsia /home/ace-tsia/.openclaw/openclaw.json

sudo systemctl restart openclaw@ace-tsia.service
sudo systemctl status openclaw@ace-tsia.service
journalctl -u openclaw@ace-tsia.service -n 50 --no-pager | grep -i context-preload
```

Esperado nos logs: `plugin loaded: tsa-context-preload` e `hook registered: before_prompt_build`.

## Smoke real Telegram

No DM do bot ace-tsia-beta:

> Cadu: o que tinha rolado ontem?

Critério de sucesso: Ace responde com referência específica a memória/artefato
de ontem (HTML gerado, decisão tomada, link público), sem alucinar. Se ele
disser "não sei o que rolou", o hook não disparou — checar logs.

Segundo teste:

> Cadu: tem alguma página pública minha?

Esperado: Ace cita URL `https://ace.caduneiva.com/...` baseado em
`publicUrlPrefix` mapeado.

## Métricas

Endpoint Prometheus do clone (porta padrão `/metrics`):

- `tsa_context_preload_runs_total{result="ok|error"}`
- `tsa_context_preload_tokens_injected_bucket` (histograma)
- `tsa_context_preload_artifacts_count` (gauge)

Alerta sugerido (ainda não criar): `result="error"` > 5 em 1h → Telegram admin.

## Rollback

Sem rebuild — só flip + restart:

```bash
sudo -u ace-tsia jq '.plugins["tsa-context-preload"].enabled = false' \
  /home/ace-tsia/.openclaw/openclaw.json > /tmp/oc.json && \
  sudo mv /tmp/oc.json /home/ace-tsia/.openclaw/openclaw.json && \
  sudo chown ace-tsia:ace-tsia /home/ace-tsia/.openclaw/openclaw.json
sudo systemctl restart openclaw@ace-tsia.service
```

Sintomas que pedem rollback:

- system prompt vai além do budget do provider (logs `prompt too long`)
- Ace começa a alucinar baseado em arquivo errado pego por mtime
- latência do `before_prompt_build` > 500ms (medir via histogram)
- `runs_total{result="error"}` cresce

## Janela de evolução para P2-E (v1.6)

Quando a Camada 4 (pgvector embedding store) estiver pronta:

1. Migrar `loadRecentMemories` e `findRecentArtifacts` para fazer query
   semântica em pgvector usando o último turn do user como query.
2. Manter session tail como está (não vale embedar conversa curta).
3. `enabled` continua false neste plugin; o novo plugin
   `tsa-context-retrieve` substitui no manifest.
