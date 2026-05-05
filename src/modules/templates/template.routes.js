import { Router } from 'express';
import multer from 'multer';
import { templateController } from './template.controller.js';
import {
  letterAiDraftValidator,
  listTemplatesValidator,
  getTemplateValidator,
  createTemplateValidator,
  updateTemplateValidator,
  deleteTemplateValidator,
  listAttachmentsValidator,
  getAttachmentValidator,
  createAttachmentValidator,
  updateAttachmentValidator,
  deleteAttachmentValidator,
  previewTemplatePdfValidator,
  generateLetterAttachmentValidator,
} from './template.validator.js';
import { validateRequest } from '../../middlewares/validate-request.middleware.js';
import { requireAuth } from '../../middlewares/index.js';

const router = Router({ mergeParams: true });

const letterAiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/pdf',
    ]);
    if (allowed.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF or images (JPEG, PNG, WebP, GIF) are allowed.'));
    }
  },
});

function letterAiUploadSingle(req, res, next) {
  letterAiUpload.single('reference')(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.message || 'Upload failed',
      });
    }
    next();
  });
}

// Templates
router.get(
  '/:tenantId/templates',
  requireAuth(),
  listTemplatesValidator,
  validateRequest,
  templateController.listTemplates
);
router.post(
  '/:tenantId/templates/letter-ai-draft',
  requireAuth(),
  letterAiUploadSingle,
  letterAiDraftValidator,
  validateRequest,
  templateController.draftLetterWithAi
);
router.get(
  '/:tenantId/templates/:templateId',
  requireAuth(),
  getTemplateValidator,
  validateRequest,
  templateController.getTemplate
);
router.post(
  '/:tenantId/templates',
  requireAuth(),
  createTemplateValidator,
  validateRequest,
  templateController.createTemplate
);
router.put(
  '/:tenantId/templates/:templateId',
  requireAuth(),
  updateTemplateValidator,
  validateRequest,
  templateController.updateTemplate
);
router.delete(
  '/:tenantId/templates/:templateId',
  requireAuth(),
  deleteTemplateValidator,
  validateRequest,
  templateController.deleteTemplate
);

router.post(
  '/:tenantId/templates/:templateId/preview-pdf',
  requireAuth(),
  previewTemplatePdfValidator,
  validateRequest,
  templateController.previewTemplatePdf
);

// Attachments (must be before /:templateId to avoid "attachments" matching templateId)
router.get(
  '/:tenantId/attachments',
  requireAuth(),
  listAttachmentsValidator,
  validateRequest,
  templateController.listAttachments
);
router.get(
  '/:tenantId/attachments/:attachmentId',
  requireAuth(),
  getAttachmentValidator,
  validateRequest,
  templateController.getAttachment
);
router.post(
  '/:tenantId/attachments',
  requireAuth(),
  createAttachmentValidator,
  validateRequest,
  templateController.createAttachment
);
router.put(
  '/:tenantId/attachments/:attachmentId',
  requireAuth(),
  updateAttachmentValidator,
  validateRequest,
  templateController.updateAttachment
);
router.delete(
  '/:tenantId/attachments/:attachmentId',
  requireAuth(),
  deleteAttachmentValidator,
  validateRequest,
  templateController.deleteAttachment
);

router.post(
  '/:tenantId/attachments/generate-letter',
  requireAuth(),
  generateLetterAttachmentValidator,
  validateRequest,
  templateController.generateLetterAttachment
);

export default router;
