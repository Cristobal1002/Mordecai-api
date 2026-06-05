/**
 * Catalog row: billing_key + stripe_mode → Stripe Price ID (price_...).
 */
import { Model, DataTypes } from 'sequelize';

export class StripeBillingPrice extends Model {
  static initModel(sequelize) {
    StripeBillingPrice.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          // DB default so INSERTs without id (SQL client, seeds) work; matches migration 061 intent.
          defaultValue: sequelize.literal('gen_random_uuid()'),
        },
        billingKey: {
          type: DataTypes.STRING(64),
          allowNull: false,
          field: 'billing_key',
        },
        stripeMode: {
          type: DataTypes.STRING(8),
          allowNull: false,
          field: 'stripe_mode',
        },
        stripePriceId: {
          type: DataTypes.STRING(255),
          allowNull: false,
          field: 'stripe_price_id',
        },
        label: {
          type: DataTypes.STRING(200),
          allowNull: true,
        },
        active: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        createdAt: {
          type: DataTypes.DATE,
          field: 'created_at',
        },
        updatedAt: {
          type: DataTypes.DATE,
          field: 'updated_at',
        },
      },
      {
        sequelize,
        modelName: 'StripeBillingPrice',
        tableName: 'stripe_billing_prices',
        timestamps: true,
        underscored: true,
        // DB columns are snake_case (field + underscored). Index must use those names, not JS attrs.
        indexes: [
          {
            name: 'uq_stripe_billing_prices_key_mode',
            unique: true,
            fields: [{ name: 'billing_key' }, { name: 'stripe_mode' }],
          },
        ],
      },
    );
    return StripeBillingPrice;
  }
}
