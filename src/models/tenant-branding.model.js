/**
 * TenantBranding - White-label branding per tenant for payment pages (1:1 with Tenant)
 * When null, use Mordecai defaults for a clean, minimal look.
 */
import { Model, DataTypes } from 'sequelize';

export class TenantBranding extends Model {
  static initModel(sequelize) {
    TenantBranding.init(
      {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenantId: {
          type: DataTypes.UUID,
          allowNull: false,
          unique: true,
          field: 'tenant_id',
          references: { model: 'tenants', key: 'id' },
        },
        companyName: { type: DataTypes.STRING(160), field: 'company_name' },
        logoUrl: { type: DataTypes.TEXT, field: 'logo_url' },
        primaryColor: { type: DataTypes.STRING(7), field: 'primary_color' },
        secondaryColor: { type: DataTypes.STRING(7), field: 'secondary_color' },
        supportEmail: { type: DataTypes.STRING(160), field: 'support_email' },
        supportPhone: { type: DataTypes.STRING(40), field: 'support_phone' },
        supportHours: { type: DataTypes.STRING(80), field: 'support_hours' },
        footerText: { type: DataTypes.TEXT, field: 'footer_text' },
        showPoweredBy: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'show_powered_by' },
        legalDisclaimerOverride: { type: DataTypes.TEXT, field: 'legal_disclaimer_override' },
        otpDeliveryLabelOverride: { type: DataTypes.STRING(120), field: 'otp_delivery_label_override' },
        signatureImageKey: { type: DataTypes.STRING(512), field: 'signature_image_key' },
        signatoryName: { type: DataTypes.STRING(160), field: 'signatory_name' },
        signatoryTitle: { type: DataTypes.STRING(160), field: 'signatory_title' },
        signatureUpdatedAt: { type: DataTypes.DATE, field: 'signature_updated_at' },
        createdAt: { type: DataTypes.DATE, field: 'created_at' },
        updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
      },
      {
        sequelize,
        modelName: 'TenantBranding',
        tableName: 'tenant_brandings',
        timestamps: true,
        underscored: true,
      }
    );
    return TenantBranding;
  }
}
