/**
 * Modelo DebtCase - Caso de cobranza (core)
 */
import { Model, DataTypes } from 'sequelize';

export class DebtCase extends Model {
  static initModel(sequelize) {
    DebtCase.init(
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
        debtorId: {
          type: DataTypes.UUID,
          allowNull: false,
          field: 'debtor_id',
          references: {
            model: 'debtors',
            key: 'id',
          },
        },
        flowPolicyId: {
          type: DataTypes.UUID,
          allowNull: true,
          field: 'flow_policy_id',
          references: {
            model: 'flow_policies',
            key: 'id',
          },
        },
        importBatchId: {
          type: DataTypes.UUID,
          allowNull: true,
          field: 'import_batch_id',
          references: {
            model: 'import_batches',
            key: 'id',
          },
        },
        pmsLeaseId: {
          type: DataTypes.UUID,
          allowNull: true,
          field: 'pms_lease_id',
          references: {
            model: 'pms_leases',
            key: 'id',
          },
        },
        amountDueCents: {
          type: DataTypes.BIGINT,
          allowNull: false,
          field: 'amount_due_cents',
        },
        currency: {
          type: DataTypes.STRING(8),
          defaultValue: 'USD',
        },
        daysPastDue: {
          type: DataTypes.INTEGER,
          allowNull: false,
          field: 'days_past_due',
        },
        dueDate: {
          type: DataTypes.DATEONLY,
          allowNull: true,
          field: 'due_date',
        },
        status: {
          type: DataTypes.ENUM(
            'NEW',
            'IN_PROGRESS',
            'CONTACTED',
            'PROMISE_TO_PAY',
            'PAYMENT_PLAN',
            'PAID',
            'NO_ANSWER',
            'REFUSED',
            'INVALID_CONTACT'
          ),
          defaultValue: 'NEW',
        },
        lastContactedAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: 'last_contacted_at',
        },
        nextActionAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: 'next_action_at',
        },
        paymentLinkUrl: {
          type: DataTypes.TEXT,
          allowNull: true,
          field: 'payment_link_url',
        },
        meta: {
          type: DataTypes.JSONB,
          defaultValue: {},
        },
        casePublicId: {
          type: DataTypes.STRING(16),
          allowNull: true,
          unique: true,
          field: 'case_public_id',
        },
        closedAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: 'closed_at',
        },
        approvalStatus: {
          type: DataTypes.STRING(32),
          defaultValue: 'APPROVED',
          field: 'approval_status',
        },
        externalKey: {
          type: DataTypes.STRING(512),
          allowNull: true,
          field: 'external_key',
        },
        lastPmsSyncAt: {
          type: DataTypes.DATE,
          allowNull: true,
          field: 'last_pms_sync_at',
        },
        riskTier: {
          type: DataTypes.STRING(16),
          allowNull: true,
          field: 'risk_tier',
        },
        internalNotes: {
          type: DataTypes.TEXT,
          allowNull: true,
          field: 'internal_notes',
        },
        mordecaiOperationalActive: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          field: 'mordecai_operational_active',
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
        modelName: 'DebtCase',
        tableName: 'debt_cases',
        timestamps: true,
        underscored: true,
        indexes: [
          {
            fields: ['tenant_id', 'status'],
          },
          {
            fields: ['tenant_id', 'days_past_due'],
          },
          {
            fields: ['tenant_id', 'next_action_at'],
          },
          {
            fields: ['tenant_id', 'debtor_id'],
          },
          {
            fields: ['pms_lease_id'],
          },
          {
            unique: true,
            fields: ['tenant_id', 'external_key'],
            name: 'idx_debt_cases_tenant_external_key',
          },
          {
            fields: ['tenant_id', 'mordecai_operational_active'],
            name: 'idx_debt_cases_tenant_mordecai_operational',
          },
        ],
      }
    );

    return DebtCase;
  }
}

