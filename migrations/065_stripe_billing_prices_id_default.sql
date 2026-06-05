-- Ensure stripe_billing_prices.id gets a UUID when inserting without id (raw SQL, GUI, etc.).
-- Tables created only via Sequelize sync often lacked this DB default.

ALTER TABLE stripe_billing_prices
    ALTER COLUMN id SET DEFAULT gen_random_uuid();
