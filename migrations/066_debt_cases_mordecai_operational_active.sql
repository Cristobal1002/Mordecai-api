-- Migration: mordecai_operational_active on debt_cases
-- Ingested cases default to inactive until tenant subscribes and explicitly activates them (billing + automations).

ALTER TABLE debt_cases
  ADD COLUMN IF NOT EXISTS mordecai_operational_active BOOLEAN;

UPDATE debt_cases
SET mordecai_operational_active = TRUE
WHERE mordecai_operational_active IS NULL;

ALTER TABLE debt_cases
  ALTER COLUMN mordecai_operational_active SET NOT NULL;

ALTER TABLE debt_cases
  ALTER COLUMN mordecai_operational_active SET DEFAULT FALSE;

COMMENT ON COLUMN debt_cases.mordecai_operational_active IS
  'When true, case counts toward metered billing and may run automations/collections. New PMS/import rows are created false until activated (requires active Stripe subscription).';

CREATE INDEX IF NOT EXISTS idx_debt_cases_tenant_mordecai_operational
  ON debt_cases (tenant_id, mordecai_operational_active);
