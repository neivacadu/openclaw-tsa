# Hermes Absorption Roadmap

Tracking what TSA absorbs from Hermes Agent (`github.com/NousResearch/hermes-agent`) into this fork as TSA code under **Estratégia C** (consume don't contribute).

## Absorbed (committed)

### v2.3 (2026-04-27)

- **Hardline blocklist 12 patterns canônicos** (Hermes commit `eb28145f` PR #15878)
  - Where: `/opt/gold-standard/security-hooks/block-destructive.sh` (TSA hook bash, fora do fork)
  - 8 novos patterns adicionados aos 12 existentes TSA = 20 deny patterns total

- **`duration_ms` em hooks PostToolUse** (Hermes commit `59b56d44` PR #15429)
  - Where: `/opt/gold-standard/security-hooks/log-bash-exec.sh` (TSA hook bash)
  - Consume `OPENCLAW_TOOL_DURATION_MS` env · SLO breach detection >30s

- **Kanban orchestration pattern** (Hermes commit `15937a6b` PR #16081)
  - Where: `/opt/kanban/board.sqlite` + `/opt/kanban/kanban-cli.py`
  - Implementação Python TSA (não código Hermes copiado) · 15 verbs

## Planned (not implemented)

### Pluggable Transport Layer (Hermes v0.11)

- **Where:** `src/transport/` no fork — refactor TS profundo
- **Why:** destrava providers (Bedrock, ChatCompletions, ResponsesApi, Codex)
- **Effort:** ~5-8h
- **Priority:** alta quando GEX131 Gemma4-TSIA virar provider real

### `/steer` busy mode (Hermes commit `635253b9` PR #16279)

- **Where:** `src/agents/run.ts` no fork
- **Why:** correção mid-run sem reset de sessão (UX Telegram melhora)
- **Effort:** ~2h
- **Priority:** média

### `pre_tool_call` blocking + `transform_tool_result` (Hermes v0.11)

- **Where:** plugin SDK no fork (`@openclaw/plugin-sdk` extensions)
- **Why:** destrava `security-hooks/*` como blocking gates de fato (hoje só logam)
- **Effort:** ~3-4h
- **Priority:** **alta** — fecha gap real do Tier 1

### Honcho memory overhaul (Hermes v0.11)

- **Where:** `src/memory/` no fork
- **Why:** memory provider 5-tool surface · context injection · cost safety
- **Effort:** ~6-10h
- **Priority:** baixa — pode conflitar com `task_ratings.sqlite` E5
- **Risk:** alto · avaliar antes de absorver

### `channel_skill_bindings` (Hermes commit `8fb861ea`)

- **Where:** `src/extensions/telegram/` + `src/extensions/discord/` no fork
- **Why:** bind skill ao canal no session start sem turn Opus de seleção · economia ~$48/dia
- **Effort:** ~3-5h (Hermes só implementou em Slack, porting pra TG/Discord)
- **Priority:** alta — ROI claro
- **Estimativa de schema:**
  ```json
  "channels": {
    "telegram": {
      "enabled": true,
      "skill_bindings": {
        "@ace_tsia_bot": ["0-gold-review", "0-kanban-orchestrator"]
      }
    },
    "discord": {
      "enabled": true,
      "skill_bindings": {
        "guild:111-tsa-internal": ["constitution-check", "incident-handler"]
      }
    }
  }
  ```

### Webhook direct-delivery zero-LLM (Hermes v0.11)

- **Where:** novo plugin no fork
- **Why:** alerts (notify-stop, integrity-check) sem passar pelo agent · economiza tokens
- **Effort:** ~2-3h
- **Priority:** média

### Remote model catalog consumer (Hermes commit `85536690`)

- **Where:** `src/config/` no fork (model_catalog config)
- **Why:** ace-tsia-beta consume `https://ace.caduneiva.com/api/model-catalog.json` (já publicado em delta 6)
- **Effort:** ~2h
- **Priority:** alta — pareando com endpoint já online

## Process

1. Commit em branch `ace-tsia` no fork
2. `pnpm build` no servidor
3. `aceupgrade openclaw ace-tsia` aplica no service
4. 5 gates G1-G5 validam
5. Soak 24-72h
6. Doc atualizada aqui + commit message linka Hermes commit/PR original
