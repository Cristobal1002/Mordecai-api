/**
 * Scheduled installments for a payment agreement (compliance / reminders).
 */
import { Model, DataTypes } from 'sequelize';

export class PaymentAgreementInstallment extends Model {
  static initModel(sequelize) {
    PaymentAgreementInstallment.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        tenantId: {
          type: DataTypes.UUID,
          allowNull: false,
          field: 'tenant_id',
          references: { model: 'tenants', key: 'id' },
        },
        agreementId: {
          type: DataTypes.UUID,
          allowNull: false,
          field: 'agreement_id',
          references: { model: 'payment_agreements', key: 'id' },
        },
        installmentNum: {
          type: DataTypes.INTEGER,
          allowNull: false,
          field: 'installment_num',
        },
        dueDate: {
          type: DataTypes.DATEONLY,
          allowNull: false,
          field: 'due_date',
        },
        amountCents: {
          type: DataTypes.BIGINT,
          allowNull: false,
          field: 'amount_cents',
        },
        status: {
          type: DataTypes.ENUM('PENDING', 'PAID', 'MISSED', 'WAIVED'),
          allowNull: false,
          defaultValue: 'PENDING',
        },
        paidAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: 'paid_at',
        },
        paidAmountCents: {
          type: DataTypes.BIGINT,
          allowNull: true,
          field: 'paid_amount_cents',
        },
        source: {
          type: DataTypes.STRING(64),
          allowNull: true,
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
        modelName: 'PaymentAgreementInstallment',
        tableName: 'payment_agreement_installments',
        timestamps: true,
        underscored: true,
        indexes: [
          { fields: ['agreement_id'] },
          { fields: ['tenant_id', 'due_date'] },
        ],
      }
    );

    return PaymentAgreementInstallment;
  }
}
