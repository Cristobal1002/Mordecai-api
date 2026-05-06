/**
 * Modelo PaymentAgreement - Acuerdos de pago
 */
import { Model, DataTypes } from 'sequelize';

export class PaymentAgreement extends Model {
  static initModel(sequelize) {
    PaymentAgreement.init(
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
          references: {
            model: 'tenants',
            key: 'id',
          },
        },
        debtCaseId: {
          type: DataTypes.UUID,
          allowNull: false,
          field: 'debt_case_id',
          references: {
            model: 'debt_cases',
            key: 'id',
          },
        },
        type: {
          type: DataTypes.ENUM('PROMISE_TO_PAY', 'INSTALLMENTS'),
          allowNull: false,
        },
        status: {
          type: DataTypes.ENUM(
            'PROPOSED',
            'PENDING',
            'ACTIVE',
            'ACCEPTED',
            'SUPERSEDED',
            'CANCELLED',
            'COMPLETED',
            'BROKEN'
          ),
          defaultValue: 'PROPOSED',
        },
        totalAmountCents: {
          type: DataTypes.BIGINT,
          allowNull: false,
          field: 'total_amount_cents',
        },
        downPaymentCents: {
          type: DataTypes.BIGINT,
          allowNull: true,
          field: 'down_payment_cents',
        },
        installments: {
          type: DataTypes.INTEGER,
          allowNull: true,
        },
        startDate: {
          type: DataTypes.DATEONLY,
          allowNull: true,
          field: 'start_date',
        },
        promiseDate: {
          type: DataTypes.DATEONLY,
          allowNull: true,
          field: 'promise_date',
        },
        paymentLinkUrl: {
          type: DataTypes.TEXT,
          allowNull: true,
          field: 'payment_link_url',
        },
        provider: {
          type: DataTypes.ENUM('STRIPE', 'NONE'),
          defaultValue: 'NONE',
        },
        providerRef: {
          type: DataTypes.STRING(160),
          allowNull: true,
          field: 'provider_ref',
        },
        terms: {
          type: DataTypes.JSONB,
          defaultValue: {},
        },
        paymentProofUrls: {
          type: DataTypes.JSONB,
          defaultValue: [],
          field: 'payment_proof_urls',
        },
        createdBy: {
          type: DataTypes.ENUM('AI', 'USER', 'SYSTEM'),
          defaultValue: 'AI',
          field: 'created_by',
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
        modelName: 'PaymentAgreement',
        tableName: 'payment_agreements',
        timestamps: true,
        underscored: true,
        indexes: [
          {
            fields: ['tenant_id', 'debt_case_id'],
          },
          {
            fields: ['tenant_id', 'status'],
          },
        ],
      }
    );

    return PaymentAgreement;
  }
}

