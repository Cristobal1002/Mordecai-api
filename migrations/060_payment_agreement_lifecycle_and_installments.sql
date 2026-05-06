-- Migration: Payment agreement lifecycle (PENDING / ACTIVE / SUPERSEDED) + installment schedule
-- Description: One operational agreement per case (partial unique index); rows for compliance tracking.

-- New agreement statuses (keep legacy PROPOSED / ACCEPTED in enum for compatibility)
DO $$ BEGIN
  ALTER TYPE payment_agreement_status ADD VALUE 'PENDING';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE payment_agreement_status ADD VALUE 'ACTIVE';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE payment_agreement_status ADD VALUE 'SUPERSEDED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Dedupe legacy ACCEPTED: keep newest per case, supersede older
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, debt_case_id
      ORDER BY created_at DESC
    ) AS rn
  FROM payment_agreements
  WHERE status = 'ACCEPTED'::payment_agreement_status
)
UPDATE payment_agreements pa
SET status = 'SUPERSEDED'::payment_agreement_status
FROM ranked r
WHERE pa.id = r.id AND r.rn > 1;

-- Map remaining ACCEPTED → ACTIVE (operational)
UPDATE payment_agreements
SET status = 'ACTIVE'::payment_agreement_status
WHERE status = 'ACCEPTED'::payment_agreement_status;

DROP INDEX IF EXISTS idx_payment_agreements_one_operational_per_case;
CREATE UNIQUE INDEX idx_payment_agreements_one_operational_per_case
  ON payment_agreements (tenant_id, debt_case_id)
  WHERE status IN (
    'PENDING'::payment_agreement_status,
    'ACTIVE'::payment_agreement_status
  );

-- Installments
DO $$ BEGIN
  CREATE TYPE payment_agreement_installment_status AS ENUM ('PENDING', 'PAID', 'MISSED', 'WAIVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payment_agreement_installments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agreement_id UUID NOT NULL REFERENCES payment_agreements(id) ON DELETE CASCADE,
  installment_num INTEGER NOT NULL,
  due_date DATE NOT NULL,
  amount_cents BIGINT NOT NULL,
  status payment_agreement_installment_status NOT NULL DEFAULT 'PENDING',
  paid_at TIMESTAMP WITH TIME ZONE,
  paid_amount_cents BIGINT,
  source VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agreement_id, installment_num)
);

CREATE INDEX IF NOT EXISTS idx_pai_agreement ON payment_agreement_installments(agreement_id);
CREATE INDEX IF NOT EXISTS idx_pai_tenant_due_pending
  ON payment_agreement_installments(tenant_id, due_date)
  WHERE status = 'PENDING'::payment_agreement_installment_status;

DROP TRIGGER IF EXISTS update_payment_agreement_installments_updated_at ON payment_agreement_installments;
CREATE TRIGGER update_payment_agreement_installments_updated_at
  BEFORE UPDATE ON payment_agreement_installments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
