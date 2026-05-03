-- tsa-budget-gate / Pick A12 — Postgres schema
--
-- Source of truth: research/picks-v31/A12-budget-gate-spec.md
-- DB host: master.tsa (Postgres 16, role tsa, db tsa_ace)
-- Apply via:
--     psql "$TSA_BUDGET_GATE_PG" -v ON_ERROR_STOP=1 -f sql/schema.sql
--
-- Idempotent — safe to run multiple times.

BEGIN;

-- pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS clients (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT        UNIQUE NOT NULL,
  tier              TEXT        NOT NULL CHECK (tier IN ('lab','v1','pro','business')),
  req_count_month   INT         NOT NULL DEFAULT 0,
  month_started_at  DATE        NOT NULL DEFAULT CURRENT_DATE,
  cap_per_month     INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_slug ON clients (slug);
CREATE INDEX IF NOT EXISTS idx_clients_tier ON clients (tier);

-- updated_at trigger
CREATE OR REPLACE FUNCTION clients_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clients_updated_at ON clients;
CREATE TRIGGER trg_clients_updated_at
BEFORE UPDATE ON clients
FOR EACH ROW
EXECUTE FUNCTION clients_set_updated_at();

-- Audit log for rollover events (optional, helps debug "why was I unblocked?")
CREATE TABLE IF NOT EXISTS budget_rollover_log (
  id           BIGSERIAL    PRIMARY KEY,
  ran_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  rows_reset   INT          NOT NULL,
  unblocked    TEXT[]       NOT NULL DEFAULT '{}'
);

-- Default ace-tsia internal lab row — so existing OpenClaw clones have a tenant.
INSERT INTO clients (slug, tier, cap_per_month)
VALUES ('ace-tsia', 'lab', NULL)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
