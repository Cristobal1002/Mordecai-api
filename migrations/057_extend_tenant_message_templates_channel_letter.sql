-- Migration: Extend tenant_message_templates channel to include 'letter'
-- Description: Allow 'letter' channel for generated PDF letters (eviction notices, etc.)

ALTER TABLE tenant_message_templates
  DROP CONSTRAINT IF EXISTS chk_template_channel;

ALTER TABLE tenant_message_templates
  ADD CONSTRAINT chk_template_channel CHECK (channel IN ('sms', 'email', 'letter'));

