import { TenantBranding } from '../../models/index.js';
import { resolveBranding } from '../../config/branding-defaults.js';
import { NotFoundError } from '../../errors/index.js';

export const brandingService = {
  get: async (tenantId) => {
    const branding = await TenantBranding.findOne({
      where: { tenantId },
    });
    return branding;
  },

  getOrResolve: async (tenantId, tenant = null) => {
    const branding = await TenantBranding.findOne({
      where: { tenantId },
    });
    return resolveBranding(branding, tenant);
  },

  upsert: async (tenantId, data) => {
    const [branding] = await TenantBranding.findOrCreate({
      where: { tenantId },
      defaults: {
        tenantId,
        companyName: data.companyName ?? null,
        logoUrl: data.logoUrl ?? null,
        primaryColor: data.primaryColor ?? null,
        secondaryColor: data.secondaryColor ?? null,
        supportEmail: data.supportEmail ?? null,
        supportPhone: data.supportPhone ?? null,
        footerText: data.footerText ?? null,
        signatureImageKey: data.signatureImageKey ?? null,
        signatoryName: data.signatoryName ?? null,
        signatoryTitle: data.signatoryTitle ?? null,
        signatureUpdatedAt: data.signatureUpdatedAt ?? null,
      },
    });

    // Don't overwrite logoUrl with a presigned URL (expires). Only accept S3 keys (tenants/...).
    const logoUpdate =
      data.logoUrl !== undefined && typeof data.logoUrl === 'string' && data.logoUrl.startsWith('tenants/')
        ? data.logoUrl
        : branding.logoUrl;

    await branding.update({
      companyName: data.companyName !== undefined ? data.companyName : branding.companyName,
      logoUrl: logoUpdate,
      primaryColor: data.primaryColor !== undefined ? data.primaryColor : branding.primaryColor,
      secondaryColor: data.secondaryColor !== undefined ? data.secondaryColor : branding.secondaryColor,
      supportEmail: data.supportEmail !== undefined ? data.supportEmail : branding.supportEmail,
      supportPhone: data.supportPhone !== undefined ? data.supportPhone : branding.supportPhone,
      footerText: data.footerText !== undefined ? data.footerText : branding.footerText,
      signatureImageKey:
        data.signatureImageKey !== undefined ? data.signatureImageKey : branding.signatureImageKey,
      signatoryName: data.signatoryName !== undefined ? data.signatoryName : branding.signatoryName,
      signatoryTitle: data.signatoryTitle !== undefined ? data.signatoryTitle : branding.signatoryTitle,
      signatureUpdatedAt:
        data.signatureUpdatedAt !== undefined ? data.signatureUpdatedAt : branding.signatureUpdatedAt,
    });

    return branding;
  },
};
