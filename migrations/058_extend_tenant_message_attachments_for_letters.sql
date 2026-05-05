-- Migration: Extend tenant_message_attachments with metadata for generated letters
-- Description: Store file metadata + traceability to cases/templates

ALTER TABLE tenant_message_attachments
  ADD COLUMN IF NOT EXISTS sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS mime_type VARCHAR(120),
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS original_filename VARCHAR(260),
  ADD COLUMN IF NOT EXISTS debt_case_id UUID REFERENCES debt_cases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS letter_template_id UUID REFERENCES tenant_message_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_tenant_message_attachments_debt_case ON tenant_message_attachments(debt_case_id);
CREATE INDEX IF NOT EXISTS idx_tenant_message_attachments_letter_template ON tenant_message_attachments(letter_template_id);

