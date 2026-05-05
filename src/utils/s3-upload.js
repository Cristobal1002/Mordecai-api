import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const getS3Client = () => {
  const region = (process.env.AWS_REGION || 'us-east-1').trim();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const config = { region };
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }
  return new S3Client(config);
};

const getBucketName = () => {
  const bucket = process.env.S3_BUCKET_NAME?.trim();
  if (!bucket) throw new Error('S3_BUCKET_NAME is required for uploads');
  return bucket;
};

/**
 * Check if logoUrl is an S3 key (stored path) vs a full URL.
 */
export const isS3Key = (logoUrl) =>
  logoUrl && typeof logoUrl === 'string' && logoUrl.startsWith('tenants/') && !logoUrl.startsWith('http');

/**
 * Resolve logo URL for display. If it's an S3 key, returns a presigned URL (1h).
 * If it's already a full URL (e.g. public bucket), returns as-is.
 */
export const resolveLogoUrl = async (logoUrl) => {
  if (!logoUrl) return null;
  if (!isS3Key(logoUrl)) return logoUrl;

  const s3 = getS3Client();
  const bucket = getBucketName();
  const command = new GetObjectCommand({ Bucket: bucket, Key: logoUrl });
  return getSignedUrl(s3, command, { expiresIn: 3600 });
};

const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
const MAX_LOGO_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Upload branding logo to S3. Returns S3 key (stored in DB; use resolveLogoUrl for display).
 * @param {string} tenantId
 * @param {string} filePath - Local file path (from multer)
 * @param {string} originalName - Original filename for extension
 * @param {string} mimetype
 * @returns {Promise<string>} S3 key (e.g. tenants/xxx/branding/logo.png)
 */
export const uploadBrandingLogo = async (tenantId, filePath, originalName, mimetype) => {
  if (!ALLOWED_LOGO_TYPES.includes(mimetype)) {
    throw new Error('Invalid file type. Use PNG, JPEG, GIF or WebP.');
  }
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_LOGO_SIZE) {
    throw new Error('Logo must be under 2MB.');
  }

  const ext = path.extname(originalName || '') || '.png';
  const key = `tenants/${tenantId}/branding/logo${ext}`;

  const s3 = getS3Client();
  const bucket = getBucketName();
  const body = fs.createReadStream(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: mimetype,
      CacheControl: 'public, max-age=86400',
    })
  );

  return key;
};

/**
 * Upload authorized signature image to S3. Returns S3 key (stored in DB).
 * @param {string} tenantId
 * @param {string} filePath
 * @param {string} originalName
 * @param {string} mimetype
 * @returns {Promise<string>} S3 key (e.g. tenants/xxx/branding/signature.png)
 */
export const uploadBrandingSignature = async (tenantId, filePath, originalName, mimetype) => {
  if (!ALLOWED_LOGO_TYPES.includes(mimetype)) {
    throw new Error('Invalid file type. Use PNG, JPEG, GIF or WebP.');
  }
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_LOGO_SIZE) {
    throw new Error('Signature image must be under 2MB.');
  }

  const ext = path.extname(originalName || '') || '.png';
  const key = `tenants/${tenantId}/branding/signature${ext}`;

  const s3 = getS3Client();
  const bucket = getBucketName();
  const body = fs.createReadStream(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: mimetype,
      CacheControl: 'private, max-age=86400',
    })
  );

  return key;
};

// --- Evidence & payment proof (disputes, agreements) ---
const ALLOWED_EVIDENCE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'application/pdf',
];
const MAX_EVIDENCE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Check if a value is an S3 key we manage (disputes/ or agreements/ prefix).
 */
export const isOurS3Key = (val) =>
  val && typeof val === 'string' && (val.startsWith('disputes/') || val.startsWith('agreements/'));

/**
 * Generate presigned PUT URL for client-side upload. Returns uploadUrl and s3Key.
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.debtCaseId - for disputes
 * @param {string} [opts.agreementId] - for agreement proof
 * @param {string} opts.filename - original filename (used for extension)
 * @param {string} opts.contentType
 * @returns {Promise<{ uploadUrl: string; s3Key: string; expiresIn: number }>}
 */
export const generatePresignedUploadUrl = async ({ tenantId, debtCaseId, agreementId, filename, contentType }) => {
  if (!ALLOWED_EVIDENCE_TYPES.includes(contentType)) {
    throw new Error('Invalid file type. Use PNG, JPEG, GIF, WebP or PDF.');
  }
  const ext = path.extname(filename || '') || (contentType === 'application/pdf' ? '.pdf' : '.png');
  const safeExt = (ext.slice(0, 20) || '.pdf').replace(/[^a-zA-Z0-9.]/g, '');
  const prefix = agreementId ? `agreements/${tenantId}/${agreementId}` : `disputes/${tenantId}/${debtCaseId}`;
  const s3Key = `${prefix}/${crypto.randomUUID()}${safeExt}`;

  const s3 = getS3Client();
  const bucket = getBucketName();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 }); // 15 min

  return { uploadUrl, s3Key, expiresIn: 900 };
};

/**
 * Resolve S3 key to presigned GET URL (1h). If not our key, returns as-is (external URL).
 */
export const resolveEvidenceOrProofUrl = async (s3KeyOrUrl) => {
  if (!s3KeyOrUrl) return null;
  if (!isOurS3Key(s3KeyOrUrl)) return s3KeyOrUrl;

  const s3 = getS3Client();
  const bucket = getBucketName();
  const command = new GetObjectCommand({ Bucket: bucket, Key: s3KeyOrUrl });
  return getSignedUrl(s3, command, { expiresIn: 3600 });
};

/**
 * Resolve array of evidence/proof items (S3 keys or URLs) to presigned view URLs.
 */
export const resolveEvidenceUrls = async (items) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  return Promise.all(items.map((item) => resolveEvidenceOrProofUrl(typeof item === 'string' ? item : item?.key ?? item)));
};

/**
 * Upload dispute evidence from server (multer file). Returns S3 key.
 * @param {string} tenantId
 * @param {string} debtCaseId
 * @param {string} filePath - Local path (from multer)
 * @param {string} originalName
 * @param {string} mimetype
 * @returns {Promise<string>} S3 key
 */
export const uploadDisputeEvidence = async (tenantId, debtCaseId, filePath, originalName, mimetype) => {
  if (!ALLOWED_EVIDENCE_TYPES.includes(mimetype)) {
    throw new Error('Invalid file type. Use PNG, JPEG, GIF, WebP or PDF.');
  }
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_EVIDENCE_SIZE) {
    throw new Error('File must be under 10MB.');
  }
  const ext = path.extname(originalName || '') || (mimetype === 'application/pdf' ? '.pdf' : '.png');
  const safeExt = (ext.slice(0, 20) || '.pdf').replace(/[^a-zA-Z0-9.]/g, '');
  const s3Key = `disputes/${tenantId}/${debtCaseId}/${crypto.randomUUID()}${safeExt}`;

  const s3 = getS3Client();
  const bucket = getBucketName();
  const body = fs.createReadStream(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: body,
      ContentType: mimetype,
    })
  );
  return s3Key;
};

/**
 * Upload agreement payment proof from server (multer file). Returns S3 key.
 * @param {string} tenantId
 * @param {string} agreementId
 * @param {string} filePath
 * @param {string} originalName
 * @param {string} mimetype
 * @returns {Promise<string>} S3 key
 */
export const uploadAgreementProof = async (tenantId, agreementId, filePath, originalName, mimetype) => {
  if (!ALLOWED_EVIDENCE_TYPES.includes(mimetype)) {
    throw new Error('Invalid file type. Use PNG, JPEG, GIF, WebP or PDF.');
  }
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_EVIDENCE_SIZE) {
    throw new Error('File must be under 10MB.');
  }
  const ext = path.extname(originalName || '') || (mimetype === 'application/pdf' ? '.pdf' : '.png');
  const safeExt = (ext.slice(0, 20) || '.pdf').replace(/[^a-zA-Z0-9.]/g, '');
  const s3Key = `agreements/${tenantId}/${agreementId}/${crypto.randomUUID()}${safeExt}`;

  const s3 = getS3Client();
  const bucket = getBucketName();
  const body = fs.createReadStream(filePath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: body,
      ContentType: mimetype,
    })
  );
  return s3Key;
};
