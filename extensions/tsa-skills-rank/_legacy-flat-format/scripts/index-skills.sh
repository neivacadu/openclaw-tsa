#!/usr/bin/env bash
# tsa-skills-rank — index-skills.sh
#
# Roda indexacao do banco de skills.
# Walks SKILLS_DIR/**/SKILL.md, parse frontmatter, upsert em skills.sqlite.
# Uso:
#   ./index-skills.sh                      # usa defaults
#   SKILLS_DIR=/custom ./index-skills.sh   # override
#   ./index-skills.sh --dry-run            # so loga, nao escreve
#
# Cron sugerido: 0 4 * * * /opt/openclaw/plugins/tsa-skills-rank/scripts/index-skills.sh
#
# NAO TOCA producao sem flag explicita.

set -euo pipefail

SKILLS_DIR="${SKILLS_DIR:-/home/ace-tsia/.openclaw/workspace/skills}"
DB_PATH="${DB_PATH:-/home/ace-tsia/.openclaw/data/skills.sqlite}"
PLUGIN_DIR="${PLUGIN_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG_FILE="${LOG_FILE:-/var/log/tsa/skills-rank-index.log}"
NODE_BIN="${NODE_BIN:-node}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "arg desconhecido: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
mkdir -p "$(dirname "$DB_PATH")" 2>/dev/null || true

log() {
  local ts msg
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  msg="[$ts] $*"
  echo "$msg" | tee -a "$LOG_FILE"
}

log "iniciando indexacao | skills_dir=$SKILLS_DIR | db=$DB_PATH | dry_run=$DRY_RUN"

if [[ ! -d "$SKILLS_DIR" ]]; then
  log "ERRO: SKILLS_DIR nao existe: $SKILLS_DIR"
  exit 2
fi

skill_count="$(find "$SKILLS_DIR" -type f -name 'SKILL.md' 2>/dev/null | wc -l | tr -d ' ')"
log "encontrou $skill_count arquivos SKILL.md"

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY RUN — saindo sem escrever no banco"
  exit 0
fi

cd "$PLUGIN_DIR"

if [[ ! -f "src/index.ts" ]]; then
  log "ERRO: nao achei src/index.ts em $PLUGIN_DIR"
  exit 3
fi

# Roda indexacao via tsx (instalado como devDep do plugin)
TSX_BIN="$PLUGIN_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  TSX_BIN="$(command -v tsx 2>/dev/null || true)"
fi

if [[ -z "$TSX_BIN" ]]; then
  log "ERRO: tsx nao encontrado. Rode 'npm install' no plugin dir antes."
  exit 4
fi

set +e
"$TSX_BIN" -e "
  import { SkillsRanker } from './src/index.ts';
  const r = new SkillsRanker({ skillsDir: '$SKILLS_DIR', dbPath: '$DB_PATH' });
  const n = r.index('$SKILLS_DIR');
  console.log('indexed=' + n);
  console.log('total_in_db=' + r.totalCount());
  r.close();
" 2>&1 | tee -a "$LOG_FILE"
RC=$?
set -e

if [[ $RC -ne 0 ]]; then
  log "ERRO: indexacao falhou rc=$RC"
  exit $RC
fi

# Push metric pro pushgateway (best-effort)
PUSHGW="${PUSHGW:-http://localhost:9091}"
if command -v curl >/dev/null 2>&1; then
  indexed_now="$(sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM skills;' 2>/dev/null || echo 0)"
  printf "tsa_skills_indexed_total %s\n" "$indexed_now" \
    | curl -fsS --max-time 3 --data-binary @- "$PUSHGW/metrics/job/tsa_skills_rank_index" >/dev/null 2>&1 || true
fi

log "indexacao concluida OK"
