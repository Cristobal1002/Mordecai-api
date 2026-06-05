import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';
import { Op } from 'sequelize';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { sequelize } from '../../config/database.js';
import { importRepository } from './import.repository.js';
import { Debtor, DebtCase, FlowPolicy } from '../../models/index.js';
import { logger } from '../../utils/logger.js';

const getS3Client = () => {
    const region = process.env.AWS_REGION;
    if (!region) {
        throw new Error('Missing AWS_REGION env var');
    }

    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    const config = { region };
    if (accessKeyId && secretAccessKey) {
        config.credentials = { accessKeyId, secretAccessKey };
    }

    return new S3Client(config);
};

const getBucketName = () => {
    const bucket = process.env.S3_BUCKET_NAME;
    if (!bucket) {
        throw new Error('Missing S3_BUCKET_NAME env var');
    }
    return bucket;
};

const buildS3Key = (tenantId, batchId, originalName) => {
    const extension = path.extname(originalName || '') || '.xlsx';
    return `tenants/${tenantId}/import-batches/${batchId}/original${extension}`;
};

const uploadToS3 = async (filePath, key) => {
    const bucket = getBucketName();
    const s3Client = getS3Client();
    const body = fs.createReadStream(filePath);

    await s3Client.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
    );
};

const downloadFromS3 = async (key) => {
    const bucket = getBucketName();
    const s3Client = getS3Client();

    const response = await s3Client.send(
        new GetObjectCommand({
            Bucket: bucket,
            Key: key,
        })
    );

    const stream = response.Body;
    if (!stream) {
        throw new Error('Empty S3 response body');
    }

    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
};

const parseDateCell = (value) => {
    if (!value) return null;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }

    if (typeof value === 'number') {
        const dateParts = xlsx.SSF.parse_date_code(value);
        if (dateParts) {
            return new Date(
                dateParts.y,
                dateParts.m - 1,
                dateParts.d,
                dateParts.H,
                dateParts.M,
                Math.round(dateParts.S)
            );
        }
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed;
    }

    return null;
};

const parseAmountToCents = (value) => {
    const raw = value === null || value === undefined ? '' : String(value).trim();
    if (!raw) {
        throw new Error('Missing amount_due');
    }

    const normalized = raw.replace(/,/g, '');
    const numberValue = Number(normalized);
    if (!Number.isFinite(numberValue)) {
        throw new Error(`Invalid amount_due: ${value}`);
    }

    return Math.round(numberValue * 100);
};

const parseDaysPastDue = (value, dueDate) => {
    const raw = value === null || value === undefined ? '' : String(value).trim();
    if (raw) {
        const numberValue = Number(raw);
        if (Number.isFinite(numberValue)) {
            return Math.max(0, Math.floor(numberValue));
        }
    }

    if (!dueDate) {
        throw new Error('Missing days_past_due and invalid due_date');
    }

    const now = new Date();
    const diffMs = now - dueDate;
    if (diffMs <= 0) {
        return 0;
    }

    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
};

const cleanString = (value) => {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    return str.length ? str : null;
};

const buildDebtorMetadata = (row) => {
    const metadata = {};
    if (cleanString(row.unit)) metadata.unit = cleanString(row.unit);
    if (cleanString(row.property_name)) metadata.property_name = cleanString(row.property_name);
    if (cleanString(row.lease_id)) metadata.lease_id = cleanString(row.lease_id);
    return metadata;
};

const buildCaseMeta = (row) => {
    const meta = {};
    if (cleanString(row.notes)) meta.notes = cleanString(row.notes);
    if (row.last_payment_date) {
        const parsedLastPayment = parseDateCell(row.last_payment_date);
        meta.last_payment_date = parsedLastPayment
            ? parsedLastPayment.toISOString()
            : row.last_payment_date;
    }
    if (cleanString(row.balance_type)) meta.balance_type = cleanString(row.balance_type);
    if (row.move_out_date) {
        const parsedMoveOut = parseDateCell(row.move_out_date);
        meta.move_out_date = parsedMoveOut
            ? parsedMoveOut.toISOString()
            : row.move_out_date;
    }
    if (cleanString(row.lease_id)) meta.lease_id = cleanString(row.lease_id);
    return meta;
};

const selectPolicyId = (policies, daysPastDue) => {
    const policy = policies.find((p) => {
        const minOk = daysPastDue >= p.minDaysPastDue;
        const maxOk = p.maxDaysPastDue === null || daysPastDue <= p.maxDaysPastDue;
        return minOk && maxOk;
    });
    return policy ? policy.id : null;
};

export const importService = {
    createBatch: async (tenantId, file) => {
        const batch = await importRepository.create({
            tenantId,
            source: 'XLSX',
            fileKey: null,
            status: 'PENDING',
            totalRows: 0,
        });

        const s3Key = buildS3Key(tenantId, batch.id, file.originalname);

        try {
            await uploadToS3(file.path, s3Key);
            await importRepository.update(batch.id, { fileKey: s3Key });
            batch.fileKey = s3Key;
        } catch (error) {
            logger.error({ error, tenantId, batchId: batch.id }, 'Error uploading XLSX to S3');
            await importRepository.update(batch.id, {
                status: 'FAILED',
                errors: [{ error: error.message }],
            });
            throw error;
        } finally {
            fs.promises.unlink(file.path).catch((err) => {
                logger.warn({ err, path: file.path }, 'Failed to delete temp file');
            });
        }

        return batch;
    },

    getBatchStatus: async (tenantId, batchId) => {
        const batch = await importRepository.findById(batchId);
        if (!batch) throw new Error('Batch not found');
        if (batch.tenantId !== tenantId) throw new Error('Unauthorized access to batch');
        return batch;
    },

    processBatch: async (tenantId, batchId) => {
        const batch = await importRepository.findById(batchId);
        if (!batch) throw new Error('Batch not found');
        if (batch.tenantId !== tenantId) throw new Error('Unauthorized');
        if (batch.status !== 'PENDING') {
            throw new Error(`Batch is in ${batch.status} status`);
        }
        if (!batch.fileKey) {
            throw new Error('Batch file key is missing');
        }

        await importRepository.update(batchId, {
            status: 'PROCESSING',
            processedAt: new Date(),
        });

        try {
            const buffer = await downloadFromS3(batch.fileKey);

            const workbook = xlsx.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

            if (rows.length === 0) {
                throw new Error('No rows found in XLSX');
            }

            await importRepository.update(batchId, { totalRows: rows.length });

            let successCount = 0;
            let errorCount = 0;
            const errors = [];

            const policies = await FlowPolicy.findAll({
                where: { tenantId, isActive: true },
                order: [['minDaysPastDue', 'ASC']],
            });

            for (const [index, row] of rows.entries()) {
                const rowIndex = index + 2;
                const t = await sequelize.transaction();

                try {
                    const fullName = cleanString(row.full_name);
                    const email = cleanString(row.email);
                    const phone = cleanString(row.phone);
                    const externalRef = cleanString(row.external_ref);

                    if (!fullName) {
                        throw new Error('Missing full_name');
                    }

                    if (!email && !phone && !externalRef) {
                        throw new Error('Missing debtor identifiers (email, phone, external_ref)');
                    }

                    const amountDueCents = parseAmountToCents(row.amount_due);
                    const dueDate = parseDateCell(row.due_date);
                    if (!dueDate) {
                        throw new Error(`Invalid due_date: ${row.due_date}`);
                    }

                    const daysPastDue = parseDaysPastDue(row.days_past_due, dueDate);
                    const currency = (cleanString(row.currency) || 'USD').toUpperCase();

                    const debtorWhere = [];
                    if (email) debtorWhere.push({ email });
                    if (phone) debtorWhere.push({ phone });
                    if (externalRef) debtorWhere.push({ externalRef });

                    let debtor = await Debtor.findOne({
                        where: {
                            tenantId,
                            [Op.or]: debtorWhere,
                        },
                        transaction: t,
                    });

                    const debtorMetadata = buildDebtorMetadata(row);

                    if (debtor) {
                        const mergedMetadata = {
                            ...(debtor.metadata || {}),
                            ...debtorMetadata,
                        };

                        await debtor.update(
                            {
                                fullName,
                                email,
                                phone,
                                externalRef,
                                metadata: mergedMetadata,
                            },
                            { transaction: t }
                        );
                    } else {
                        debtor = await Debtor.create(
                            {
                                tenantId,
                                externalRef,
                                fullName,
                                email,
                                phone,
                                metadata: debtorMetadata,
                            },
                            { transaction: t }
                        );
                    }

                    const flowPolicyId = selectPolicyId(policies, daysPastDue);
                    const caseMeta = buildCaseMeta(row);

                    let debtCase = await DebtCase.findOne({
                        where: {
                            tenantId,
                            debtorId: debtor.id,
                            importBatchId: batch.id,
                        },
                        transaction: t,
                    });

                    if (debtCase) {
                        const mergedMeta = {
                            ...(debtCase.meta || {}),
                            ...caseMeta,
                        };

                        await debtCase.update(
                            {
                                amountDueCents,
                                dueDate,
                                daysPastDue,
                                currency,
                                flowPolicyId,
                                meta: mergedMeta,
                            },
                            { transaction: t }
                        );
                    } else {
                        await DebtCase.create(
                            {
                                tenantId,
                                debtorId: debtor.id,
                                importBatchId: batch.id,
                                amountDueCents,
                                currency,
                                daysPastDue,
                                dueDate,
                                status: 'NEW',
                                mordecaiOperationalActive: false,
                                nextActionAt: new Date(),
                                flowPolicyId,
                                meta: caseMeta,
                            },
                            { transaction: t }
                        );
                    }

                    await t.commit();
                    successCount++;
                } catch (err) {
                    await t.rollback();
                    errorCount++;
                    errors.push({
                        row: rowIndex,
                        error: err.message,
                        data: row,
                    });
                }
            }

            const status = errorCount === rows.length ? 'FAILED' : 'COMPLETED';
            await importRepository.update(batchId, {
                status,
                successRows: successCount,
                errorRows: errorCount,
                errors,
                processedAt: new Date(),
            });

            return {
                status,
                total: rows.length,
                success: successCount,
                failed: errorCount,
            };
        } catch (error) {
            logger.error({ error, batchId }, 'Fatal error processing batch');
            await importRepository.update(batchId, {
                status: 'FAILED',
                errors: [{ error: `Fatal error: ${error.message}` }],
                processedAt: new Date(),
            });
            throw error;
        }
    },
};
