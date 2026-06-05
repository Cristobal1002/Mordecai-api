-- Migration: Internal notes on debt cases (PM / staff, not from PMS)
ALTER TABLE debt_cases
  ADD COLUMN IF NOT EXISTS internal_notes TEXT;

COMMENT ON COLUMN debt_cases.internal_notes IS
  'Free-form notes by property staff; not synced from PMS.';
