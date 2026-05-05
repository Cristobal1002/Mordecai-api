-- Migration: Extend tenant_brandings with authorized signature fields
-- Description: Stores signature image reference + signatory metadata to stamp letters.

ALTER TABLE tenant_brandings
  ADD COLUMN IF NOT EXISTS signature_image_key VARCHAR(512),
  ADD COLUMN IF NOT EXISTS signatory_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS signatory_title VARCHAR(160),
  ADD COLUMN IF NOT EXISTS signature_updated_at TIMESTAMP WITH TIME ZONE;

