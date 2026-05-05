import fs from 'fs';
import path from 'path';
import { TenantBranding, Tenant } from '../../models/index.js';
import { brandingService } from './branding.service.js';
import { tenantService } from '../tenants/tenant.service.js';
import { uploadBrandingLogo, uploadBrandingSignature, resolveLogoUrl } from '../../utils/s3-upload.js';

const requireTenantAdmin = async (tenantId, req) => {
  await tenantService.getAdminSnapshot(tenantId, req);
};

export const brandingController = {
  get: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      await tenantService.requireTenantAdmin(tenantId, req);

      const branding = await brandingService.get(tenantId);
      let logoUrl = branding?.logoUrl ?? null;
      if (logoUrl) {
        logoUrl = await resolveLogoUrl(logoUrl);
      }
      const payload = branding
        ? {
            id: branding.id,
            companyName: branding.companyName,
            logoUrl,
            primaryColor: branding.primaryColor,
            secondaryColor: branding.secondaryColor,
            supportEmail: branding.supportEmail,
            supportPhone: branding.supportPhone,
            footerText: branding.footerText,
            signatureImageKey: branding.signatureImageKey ?? null,
            signatoryName: branding.signatoryName ?? null,
            signatoryTitle: branding.signatoryTitle ?? null,
            signatureUpdatedAt: branding.signatureUpdatedAt ?? null,
          }
        : null;

      res.ok(payload, 'Branding retrieved');
    } catch (error) {
      next(error);
    }
  },

  upsert: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      await tenantService.requireTenantAdmin(tenantId, req);

      const branding = await brandingService.upsert(tenantId, req.body);
      res.ok(
        {
          id: branding.id,
          companyName: branding.companyName,
          logoUrl: branding.logoUrl,
          primaryColor: branding.primaryColor,
          secondaryColor: branding.secondaryColor,
          supportEmail: branding.supportEmail,
          supportPhone: branding.supportPhone,
          footerText: branding.footerText,
          signatureImageKey: branding.signatureImageKey ?? null,
          signatoryName: branding.signatoryName ?? null,
          signatoryTitle: branding.signatoryTitle ?? null,
          signatureUpdatedAt: branding.signatureUpdatedAt ?? null,
        },
        'Branding updated'
      );
    } catch (error) {
      next(error);
    }
  },

  uploadLogo: async (req, res, next) => {
    let filePath = null;
    try {
      const { tenantId } = req.params;
      await requireTenantAdmin(tenantId, req);

      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });
      }
      filePath = req.file.path || path.join(req.file.destination || 'uploads/branding', req.file.filename);

      const logoKey = await uploadBrandingLogo(
        tenantId,
        filePath,
        req.file.originalname,
        req.file.mimetype
      );

      const branding = await brandingService.upsert(tenantId, { logoUrl: logoKey });
      const resolvedLogoUrl = await resolveLogoUrl(logoKey);

      res.ok(
        {
          id: branding.id,
          companyName: branding.companyName,
          logoUrl: resolvedLogoUrl,
          primaryColor: branding.primaryColor,
          secondaryColor: branding.secondaryColor,
          supportEmail: branding.supportEmail,
          supportPhone: branding.supportPhone,
          footerText: branding.footerText,
        },
        'Logo actualizado'
      );
    } catch (error) {
      next(error);
    } finally {
      if (filePath) {
        fs.unlink(filePath, () => {});
      }
    }
  },

  uploadSignature: async (req, res, next) => {
    let filePath = null;
    try {
      const { tenantId } = req.params;
      await requireTenantAdmin(tenantId, req);

      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });
      }
      filePath = req.file.path || path.join(req.file.destination || 'uploads/branding', req.file.filename);

      const sigKey = await uploadBrandingSignature(
        tenantId,
        filePath,
        req.file.originalname,
        req.file.mimetype
      );

      const branding = await brandingService.upsert(tenantId, {
        signatureImageKey: sigKey,
        signatureUpdatedAt: new Date(),
      });

      res.ok(
        {
          id: branding.id,
          signatureImageKey: branding.signatureImageKey ?? null,
          signatoryName: branding.signatoryName ?? null,
          signatoryTitle: branding.signatoryTitle ?? null,
          signatureUpdatedAt: branding.signatureUpdatedAt ?? null,
        },
        'Firma actualizada'
      );
    } catch (error) {
      next(error);
    } finally {
      if (filePath) {
        fs.unlink(filePath, () => {});
      }
    }
  },
};
