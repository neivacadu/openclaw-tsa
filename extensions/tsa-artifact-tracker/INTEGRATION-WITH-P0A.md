# Integração: tsa-artifact-tracker ↔ tsa-context-preload (P0-A)

## Por que existe

Hoje (28/04) o `tsa-context-preload` (P0-A) reconstrói "o que o Ace fez
recentemente" varrendo o filesystem por `mtime` em diretórios conhecidos
(`/var/www/ace/`, `~/Documents/TSA-ACE/`, etc). Isso tem 3 problemas:

1. **Falsos positivos**: pega dot-files, `.DS_Store`, logs do sistema, qualquer
   coisa que mexeu no diretório (rsync, backup, OS).
2. **Sem semântica**: não sabe se o arquivo é um _artefato Ace-gerado_ ou um
   input que o usuário copiou pra lá.
3. **Sem URL pública**: precisa heurística separada pra inferir
   `https://ace.caduneiva.com/<x>` — duplicada em P0-A e em outros lugares.

`tsa-artifact-tracker` (P1-D) resolve os três: cada artefato é registrado **no
momento da criação**, com kind, agente, sessão, prompt e public_url já
materializados.

---

## Contrato

P0-A passa a chamar a tool `artifacts_recent` ao invés de fazer `find`:

```typescript
// ANTES (P0-A v0): heurística de mtime
const recent = await fs.readdir(...).filter(byMtime).filter(byExtAllow);

// DEPOIS (P0-A v1, com P1-D habilitado):
const recent = await tools.artifacts_recent({ hours_back: 24, limit: 20 });
// recent[i] já vem com: { path, filename, kind, public_url, created_by_agent,
//                         created_in_session, prompt_summary, status }
```

E o bloco que P0-A injeta no preâmbulo da sessão muda de:

```
Arquivos modificados nas últimas 24h:
- /var/www/ace/foo.html (12KB, html)
- ...
```

para algo semanticamente útil:

```
Artefatos que VOCÊ gerou nas últimas 24h:
- aula-vendas-ace-tsa.html (html, 0-creator, sessão sess-7f2a)
  publicado em https://ace.caduneiva.com/aula-vendas-ace-tsa.html
  prompt: "gerar aula vendas ace tsa"
- relatorio-q2.pdf (pdf, 0-hunter, sessão sess-7f2b)
  prompt: "consolidar resultados Q2"
```

---

## Ordem de habilitação

P1-D **precisa estar populando** antes de P0-A começar a consumir, senão o
preâmbulo fica vazio e o Ace cai no comportamento atual (find por mtime).

```
T+0    Habilita tsa-artifact-tracker (manifest.enabled = true).
       Hook after_tool_call começa a popular artifacts.sqlite.

T+24h  Verificar:
         sqlite3 .../artifacts.sqlite \
           'SELECT COUNT(*) FROM artifacts WHERE created_at >= datetime("now","-24 hours");'
       Esperado: > 0 (qualquer Write/Edit/Bash com >).

T+24h+ Atualizar P0-A pra chamar artifacts_recent.
       Manter fallback de mtime por mais 7 dias com flag preferTracker=true.

T+7d   Remover fallback de mtime do P0-A.
```

---

## Fallback / degradação

Se `artifacts_recent` lança erro (DB corrompido, plugin desabilitado, schema
desatualizado), P0-A volta ao `find -mtime` legado. Pseudocódigo:

```typescript
let artifacts: Artifact[] = [];
try {
  if (cfg.preferTracker) {
    artifacts = await tools.artifacts_recent({ hours_back: 24, limit: 20 });
  }
} catch (e) {
  log.warn("[p0a] tracker unavailable, falling back to mtime", e);
}
if (artifacts.length === 0) artifacts = await legacyMtimeScan();
```

---

## "Atualiza a página" — caso canônico

O cenário de motivação:

1. Sessão A: `0-creator` gera `/var/www/ace/aula-vendas-ace-tsa.html`.
   - P1-D registra: kind=html, public_url=`https://ace.caduneiva.com/...`,
     status=active, prompt_summary="aula de vendas".
2. Sessão B (dias depois): usuário diz "atualiza a aula de vendas".
   - P0-A já injetou no preâmbulo o artefato (via `artifacts_recent` ou
     `artifacts_search`).
   - Ace conhece o path + URL sem precisar perguntar.
3. Antes de regerar, Ace chama `artifacts_update_status({path, status:"archived"})`
   — preserva histórico.
4. Novo Write cria a versão atualizada → P1-D registra de novo (UPSERT por
   `path` mantém uma única row com `updated_at` novo e status=active).

Sem P1-D, passo 2 falha — o Ace pergunta "qual aula?" ou inventa um path.

---

## Itens que NÃO entram em P1-D (deixados para depois)

- Sync `artifacts.sqlite` → Postgres central (Camada 7). P1-D é local-only.
- Embeddings de `prompt_summary` pra busca semântica (FTS5 já cobre 80%).
- Reescrita histórica do `find -mtime` que P0-A já fez antes do tracker
  existir (data anterior a T+0 fica órfã; aceitável).
