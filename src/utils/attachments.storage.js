import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { logger } from './logger.js';

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
  if (!bucket) throw new Error('S3_BUCKET_NAME is required for attachments');
  return bucket;
};

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
};

export const computeSha256Hex = (buf) =>
  crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Upload an attachment buffer to S3 under attachments/{tenantId}/...
 * Returns { key, sha256, sizeBytes }.
 */
export const uploadTenantAttachmentBuffer = async ({
  tenantId,
  debtCaseId,
  filename,
  contentType = 'application/pdf',
  buffer,
}) => {
  if (!tenantId) throw new Error('tenantId is required');
  if (!buffer || !Buffer.isBuffer(buffer)) throw new Error('buffer is required');

  const safeName = (filename || 'attachment.pdf').slice(0, 200).replace(/[^a-zA-Z0-9._-]/g, '_');
  const prefix = debtCaseId ? `attachments/${tenantId}/${debtCaseId}` : `attachments/${tenantId}`;
  const key = `${prefix}/${crypto.randomUUID()}-${safeName}`;
  const sha256 = computeSha256Hex(buffer);
  const sizeBytes = buffer.length;

  const s3 = getS3Client();
  const bucket = getBucketName();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  logger.info({ tenantId, debtCaseId, key, sizeBytes }, 'Attachment uploaded to S3');
  return { key, sha256, sizeBytes };
};

export const getTenantAttachmentBuffer = async (key) => {
  if (!key) throw new Error('key is required');
  const s3 = getS3Client();
  const bucket = getBucketName();
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error('S3 object Body is empty');
  return streamToBuffer(res.Body);
};

