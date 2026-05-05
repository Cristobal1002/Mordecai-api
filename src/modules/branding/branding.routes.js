import fs from 'fs';
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { validateRequest } from '../../middlewares/validate-request.middleware.js';
import { requireAuth } from '../../middlewares/index.js';
import { brandingController } from './branding.controller.js';
import { getBrandingValidator, upsertBrandingValidator, logoUploadValidator } from './branding.validator.js';

const router = Router();

const uploadDir = 'uploads/branding';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.png';
    cb(null, `logo-${Date.now()}${ext}`);
  },
});

const signatureStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.png';
    cb(null, `signature-${Date.now()}${ext}`);
  },
});

const logoUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten imágenes (PNG, JPEG, GIF, WebP)'));
  },
});

const signatureUpload = multer({
  storage: signatureStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten imágenes (PNG, JPEG, GIF, WebP)'));
  },
});

router.get(
  '/:tenantId/branding',
  requireAuth(),
  getBrandingValidator,
  validateRequest,
  brandingController.get
);

router.put(
  '/:tenantId/branding',
  requireAuth(),
  upsertBrandingValidator,
  validateRequest,
  brandingController.upsert
);

router.post(
  '/:tenantId/branding/logo',
  requireAuth(),
  logoUpload.single('logo'),
  logoUploadValidator,
  validateRequest,
  brandingController.uploadLogo
);

router.post(
  '/:tenantId/branding/signature',
  requireAuth(),
  signatureUpload.single('signature'),
  logoUploadValidator,
  validateRequest,
  brandingController.uploadSignature
);

export default router;
