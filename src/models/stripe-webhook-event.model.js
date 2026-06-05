import { Model, DataTypes } from 'sequelize';

export class StripeWebhookEvent extends Model {
  static initModel(sequelize) {
    StripeWebhookEvent.init(
      {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        stripeEventId: { type: DataTypes.STRING(128), allowNull: false, field: 'stripe_event_id' },
        stripeMode: { type: DataTypes.STRING(8), allowNull: false, field: 'stripe_mode' },
        type: { type: DataTypes.STRING(120), allowNull: false },
        createdAt: { type: DataTypes.DATE, field: 'created_at' },
      },
      {
        sequelize,
        modelName: 'StripeWebhookEvent',
        tableName: 'stripe_webhook_events',
        timestamps: true,
        updatedAt: false,
        underscored: true,
      }
    );
    return StripeWebhookEvent;
  }
}

