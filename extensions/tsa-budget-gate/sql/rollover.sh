#!/usr/bin/env bash
#
# tsa-budget-gate — monthly rollover
#
# Cron entry on master.tsa (UTC):
#     0 0 1 * *  /opt/tsa-ace-master/plugins/tsa-budget-gate/sql/rollover.sh
#
# São Paulo (UTC-3) cron equivalent: `0 3 1 * *`.
#
# Steps:
#   1. Snapshot which slugs are currently capped (req_count_month >= cap_per_month).
#   2. UPDATE clients SET req_count_month=0, month_started_at=CURRENT_DATE.
#   3. Insert into budget_rollover_log.
#   4. (Optional) curl OpenClaw plugin /admin/rollover to make it re-fan
#      Telegram notifications via the running plugin runtime.
#
# All work happens in a single transaction; partial rollovers are impossible.
#
# Required env:
#   TSA_BUDGET_GATE_PG   — psql connection string

set -euo pipefail

: "${TSA_BUDGET_GATE_PG:?missing TSA_BUDGET_GATE_PG}"

LOG_TAG="[tsa-budget-gate rollover]"
echo "${LOG_TAG} starting at $(date -Iseconds)"

psql "$TSA_BUDGET_GATE_PG" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

WITH was_blocked AS (
  SELECT slug
    FROM clients
   WHERE cap_per_month IS NOT NULL
     AND req_count_month >= cap_per_month
),
upd AS (
  UPDATE clients
     SET req_count_month  = 0,
         month_started_at = CURRENT_DATE
   RETURNING slug
)
INSERT INTO budget_rollover_log (rows_reset, unblocked)
SELECT
  (SELECT COUNT(*) FROM upd)::INT,
  COALESCE(ARRAY(SELECT slug FROM was_blocked), '{}');

COMMIT;
SQL

# Optional: poke the live plugin so it re-fans Telegram notifications.
if [[ -n "${TSA_BUDGET_GATE_ADMIN_URL:-}" ]]; then
  curl -fsS -X POST "${TSA_BUDGET_GATE_ADMIN_URL%/}/rollover" \
       -H "authorization: Bearer ${TSA_BUDGET_GATE_ADMIN_TOKEN:-}" \
       -H "content-type: application/json" \
       --max-time 10 \
       || echo "${LOG_TAG} admin endpoint unreachable, telegram fan-out skipped"
fi

echo "${LOG_TAG} done at $(date -Iseconds)"
