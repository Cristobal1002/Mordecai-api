-- Seed Stripe live price catalog (price_... IDs from Stripe Dashboard, live mode).
-- Safe to re-run: upserts on (billing_key, stripe_mode).

INSERT INTO stripe_billing_prices (billing_key, stripe_mode, stripe_price_id, label, active) VALUES
  ('platform_base',     'live', 'price_1Td0r8CbnQFrbipGWs8ydEdt', 'Mordecai — Base plataforma', true),
  ('pms_units_metered','live', 'price_1Td0r8CbnQFrbipGIqNdkD4A', 'Mordecai — Unidades PMS', true),
  ('calls_none',        'live', 'price_1Td0r9CbnQFrbipGWoHj3gXx', 'AI calls none', true),
  ('calls_starter',     'live', 'price_1Td0r9CbnQFrbipGIfLzoTdN', 'AI calls starter', true),
  ('calls_growth',      'live', 'price_1Td0r9CbnQFrbipGr4AyIicG', 'AI calls growth', true),
  ('calls_pro',         'live', 'price_1Td0r9CbnQFrbipG14ScvpBe', 'AI calls pro', true),
  ('white_label',       'live', 'price_1Td0r8CbnQFrbipGPe0XylNG', 'White-label', true),
  ('seat_extra',        'live', 'price_1Td0r8CbnQFrbipGoBvnJL1j', 'Extra seat', true)
ON CONFLICT (billing_key, stripe_mode) DO UPDATE SET
  stripe_price_id = EXCLUDED.stripe_price_id,
  label = EXCLUDED.label,
  active = EXCLUDED.active,
  updated_at = CURRENT_TIMESTAMP;
