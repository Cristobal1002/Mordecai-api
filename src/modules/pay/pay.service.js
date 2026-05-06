import crypto from 'crypto';
import { Op } from 'sequelize';
import {
  PaymentLink,
  TenantBranding,
  Tenant,
  DebtCase,
  Debtor,
  PaymentAgreement,
  PaymentAgreementInstallment,
  PmsLease,
  PmsUnit,
  CollectionEvent,
  ArCharge,
  ArPayment,
  CaseDispute,
} from '../../models/index.js';
import { resolveBranding } from '../../config/branding-defaults.js';
import {
  resolveLogoUrl,
  generatePresignedUploadUrl,
  resolveEvidenceOrProofUrl,
  resolveEvidenceUrls,
  isOurS3Key,
  uploadDisputeEvidence as s3UploadDisputeEvidence,
  uploadAgreementProof as s3UploadAgreementProof,
} from '../../utils/s3-upload.js';
import { maskEmail } from '../../utils/mask-email.js';
import { signPaySession, verifyPaySession } from './pay-jwt.js';
import { sendTwilioSms } from '../twilio/sms/twilio.sms.client.js';
import { sendOtpEmail } from '../../services/email.service.js';
import { logger } from '../../utils/logger.js';
import { buildPaymentInstructions } from './payment-instructions.service.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve token (UUID or short_token) to PaymentLink.
 * Supports both /p/abc12xyz and /p/550e8400-e29b-41d4-a716-446655440000
 */
async function resolvePaymentLink(token, options = {}) {
  if (!token || typeof token !== 'string') return null;
  const isUuid = UUID_REGEX.test(token.trim());
  const where = isUuid ? { token: token.trim() } : { shortToken: token.trim() };
  return PaymentLink.findOne({
    where,
    ...options,
  });
}

const normalizeForVerify = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const getLastWord = (fullName) => {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
};

export const payService = {
  /**
   * GET /pay/:token — First touch. Registers click, returns branding only.
   */
  getByToken: async (token, req) => {
    const link = await resolvePaymentLink(token, {
      include: [
        { model: Tenant, as: 'tenant', attributes: ['id', 'name'] },
        { model: DebtCase, as: 'debtCase', include: [{ model: Debtor, as: 'debtor', attributes: ['email', 'phone'] }] },
      ],
    });

    if (!link) return { status: 404 };
    if (link.status === 'BLOCKED') return { status: 423, link };
    if (link.status === 'PAID') return { status: 410, link };
    if (link.status === 'EXPIRED' || (link.expiresAt && new Date(link.expiresAt) < new Date())) {
      if (link.status !== 'EXPIRED') await link.update({ status: 'EXPIRED' });
      return { status: 410, link };
    }

    // Register first click (with channel attribution: ?source=sms | ?source=email, ?aid=automationId)
    const clickSource = (req.query?.source || req.query?.utm_source || '').toString().toLowerCase().slice(0, 32);
    const validSource = ['sms', 'email'].includes(clickSource) ? clickSource : null;
    const aid = (req.query?.aid || '').toString().trim();
    const automationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(aid) ? aid : null;

    if (!link.clickedAt) {
      await link.update({
        clickedAt: new Date(),
        clickSource: validSource,
        clickIp: req.ip || req.connection?.remoteAddress || null,
        clickUserAgent: req.get('user-agent') || null,
      });
      // Emit link_clicked for Activity (compliance audit) when we have automation context
      if (automationId && link.debtCaseId) {
        try {
          await CollectionEvent.create({
            automationId,
            debtCaseId: link.debtCaseId,
            channel: validSource || 'link',
            eventType: 'link_clicked',
            payload: {
              paymentLinkId: link.id,
              source: validSource,
              ip: req.ip || req.connection?.remoteAddress || null,
              userAgent: req.get('user-agent') || null,
            },
          });
        } catch (e) {
          logger.warn({ err: e, debtCaseId: link.debtCaseId, automationId }, 'Failed to emit link_clicked event');
        }
      }
    }

    const branding = await TenantBranding.findOne({ where: { tenantId: link.tenantId } });
    const tenant = link.tenant || (await Tenant.findByPk(link.tenantId, { attributes: ['id', 'name'] }));
    const resolved = resolveBranding(branding, tenant);
    const logoUrl = resolved.logoUrl ? await resolveLogoUrl(resolved.logoUrl) : null;
    const debtorEmail = link.debtCase?.debtor?.email;
    const maskedEmailVal = debtorEmail ? maskEmail(debtorEmail) : null;
    const hasEmail = Boolean(debtorEmail?.trim());
    const hasPhone = Boolean(link.debtCase?.debtor?.phone?.trim());

    return {
      status: 200,
      payload: {
        status: link.status,
        maskedEmail: maskedEmailVal,
        hasEmail,
        hasPhone,
        branding: {
          companyName: resolved.companyName,
          logoUrl,
          primaryColor: resolved.primaryColor,
          secondaryColor: resolved.secondaryColor,
          supportEmail: resolved.supportEmail,
          supportPhone: resolved.supportPhone,
          supportHours: resolved.supportHours,
          footerText: resolved.footerText,
          showPoweredBy: resolved.showPoweredBy,
          legalDisclaimerOverride: resolved.legalDisclaimerOverride,
          otpDeliveryLabelOverride: resolved.otpDeliveryLabelOverride,
        },
      },
    };
  },

  /**
   * POST /pay/:token/verify — Verify identity by last name + unit number.
   * On success: status → VERIFIED, returns short-lived JWT for /details.
   */
  verify: async (token, body) => {
    const { lastName, unitNumber } = body || {};
    const link = await resolvePaymentLink(token, {
      include: [
        { model: DebtCase, as: 'debtCase', include: [{ model: Debtor, as: 'debtor' }] },
      ],
    });

    if (!link) return { status: 404 };
    if (link.status === 'BLOCKED') return { status: 423 };
    if (link.status === 'PAID') return { status: 410 };
    if (link.status === 'EXPIRED' || (link.expiresAt && new Date(link.expiresAt) < new Date())) {
      if (link.status !== 'EXPIRED') await link.update({ status: 'EXPIRED' });
      return { status: 410 };
    }
    if (link.status === 'VERIFIED') {
      const paySessionToken = signPaySession(link.token);
      const urlToken = link.shortToken || link.token;
      return { status: 200, payload: { verified: true, token: urlToken, paySessionToken } };
    }

    const maxAttempts = 5;
    if (link.verificationAttempts >= maxAttempts) {
      await link.update({ status: 'BLOCKED' });
      return { status: 429, message: 'Too many verification attempts' };
    }

    const debtor = link.debtCase?.debtor;
    if (!debtor) return { status: 500, message: 'Case data incomplete' };

    const storedLastName =
      debtor.metadata?.last_name ??
      debtor.metadata?.lastName ??
      getLastWord(debtor.fullName);

    let storedUnit =
      link.debtCase?.meta?.unit_number ??
      link.debtCase?.meta?.unitNumber ??
      debtor.metadata?.unit ??
      '';
    if (!storedUnit) {
      const pmsLeaseId = link.debtCase?.meta?.pms_lease_id ?? link.debtCase?.meta?.pmsLeaseId;
      if (pmsLeaseId) {
        const lease = await PmsLease.findByPk(pmsLeaseId, {
          include: [{ model: PmsUnit, as: 'pmsUnit', attributes: ['unitNumber'] }],
        });
        storedUnit = lease?.pmsUnit?.unitNumber ?? '';
      }
    }

    const inputLast = normalizeForVerify(lastName);
    const inputUnit = normalizeForVerify(unitNumber);
    const storedLast = normalizeForVerify(storedLastName);
    const storedUnitNorm = normalizeForVerify(storedUnit);

    await link.increment('verificationAttempts');

    if (inputLast !== storedLast || inputUnit !== storedUnitNorm) {
      return { status: 401, message: 'Verification failed' };
    }

    await link.update({
      status: 'VERIFIED',
      verifiedAt: new Date(),
      verificationMethod: 'LEASE_DATA',
    });

    const paySessionToken = signPaySession(link.token);
    const urlToken = link.shortToken || link.token;
    return {
      status: 200,
      payload: { verified: true, token: urlToken, paySessionToken },
    };
  },

  /**
   * GET /pay/:token/details — Requires paySessionToken (JWT) in Authorization header.
   * Returns full case/agreement data for checkout.
   */
  getDetails: async (token, authHeader) => {
    const decoded = verifyPaySession(authHeader?.replace(/^Bearer\s+/i, '')?.trim());
    if (!decoded) return { status: 401, message: 'Invalid or expired session' };

    const link = await resolvePaymentLink(token, {
      include: [
        {
          model: DebtCase,
          as: 'debtCase',
          attributes: ['id', 'casePublicId', 'amountDueCents', 'currency', 'daysPastDue', 'dueDate', 'status', 'meta', 'pmsLeaseId'],
          include: [
            { model: Debtor, as: 'debtor', attributes: ['id', 'fullName', 'email', 'phone'] },
          ],
        },
        {
          model: PaymentAgreement,
          as: 'paymentAgreement',
          required: false,
          attributes: ['id', 'totalAmountCents', 'downPaymentCents', 'installments', 'status', 'type', 'terms'],
          include: [
            {
              model: PaymentAgreementInstallment,
              as: 'installmentSchedule',
              required: false,
            },
          ],
        },
      ],
    });

    if (!link) return { status: 404 };
    if (decoded.payToken !== link.token) return { status: 401, message: 'Invalid or expired session' };
    if (link.status !== 'VERIFIED' && link.status !== 'PENDING') {
      if (link.status === 'PAID') return { status: 410 };
      if (link.status === 'EXPIRED' || link.status === 'BLOCKED') return { status: 410 };
    }

    const dc = link.debtCase;
    const debtor = dc?.debtor;
    const tenantId = link.tenantId;
    const pmsLeaseId = dc?.pmsLeaseId ?? dc?.meta?.pms_lease_id ?? dc?.meta?.pmsLeaseId ?? null;

    const [paymentInstructions, chargesRaw, paymentsRaw, openDisputeRaw, brandingRes] = await Promise.all([
      buildPaymentInstructions({
        tenantId,
        debtCaseId: dc?.id,
        casePublicId: dc?.casePublicId ?? null,
        debtorId: debtor?.id,
        pmsLeaseId,
      }),
      pmsLeaseId && tenantId
        ? ArCharge.findAll({
            where: { pmsLeaseId, tenantId },
            attributes: ['id', 'chargeType', 'description', 'amountCents', 'openAmountCents', 'dueDate'],
            order: [['dueDate', 'DESC']],
            limit: 20,
            raw: true,
          })
        : [],
      pmsLeaseId && tenantId
        ? ArPayment.findAll({
            where: { pmsLeaseId, tenantId },
            attributes: ['id', 'amountCents', 'paidAt', 'paymentMethod', 'externalId'],
            order: [['paidAt', 'DESC']],
            limit: 10,
            raw: true,
          })
        : [],
      dc?.id
        ? CaseDispute.findOne({
            where: { debtCaseId: dc.id, status: 'OPEN' },
            attributes: ['id', 'reason', 'notes', 'openedAt', 'evidenceUrls'],
            raw: true,
          })
        : null,
      TenantBranding.findOne({ where: { tenantId } }),
    ]);

    const unitNumber = dc?.meta?.unit_number ?? dc?.meta?.unitNumber ?? debtor?.metadata?.unit ?? null;
    const propertyName = dc?.meta?.property_name ?? dc?.meta?.propertyName ?? null;

    const rent = [];
    const fees = [];
    for (const c of Array.isArray(chargesRaw) ? chargesRaw : []) {
      const charge = {
        id: c.id,
        chargeType: c.chargeType,
        description: c.description,
        amountCents: Number(c.amountCents ?? 0),
        openAmountCents: c.openAmountCents != null ? Number(c.openAmountCents) : null,
        dueDate: c.dueDate,
        status: c.openAmountCents === 0 ? 'Paid' : 'Unpaid',
      };
      const ct = String(c.chargeType ?? '').toLowerCase();
      if (ct.includes('rent')) {
        rent.push(charge);
      } else {
        fees.push(charge);
      }
    }

    const payments = (Array.isArray(paymentsRaw) ? paymentsRaw : []).map((p) => ({
      id: p.id,
      amountCents: Number(p.amountCents ?? 0),
      paymentDate: p.paidAt,
      type: p.paymentMethod ?? 'Payment',
      referenceNumber: p.externalId ?? null,
    }));

    const isCurrentOnPayments =
      (dc?.amountDueCents === 0) || (dc?.status === 'PAID') || (dc?.daysPastDue === 0);

    const agreement = link.paymentAgreement;
    let agreementPayload = null;
    if (agreement) {
      const terms = agreement.terms && typeof agreement.terms === 'object' ? agreement.terms : {};
      const installmentsFromTerms = Array.isArray(terms.installments) ? terms.installments : [];
      const scheduleRows = agreement.installmentSchedule
        ? [...agreement.installmentSchedule].sort(
            (x, y) =>
              (Number(x.installmentNum ?? x.installment_num) || 0) -
              (Number(y.installmentNum ?? y.installment_num) || 0)
          )
        : [];
      const installmentsSchedule =
        scheduleRows.length > 0
          ? scheduleRows.map((row) => ({
              installmentNum: row.installmentNum ?? row.installment_num,
              dueDate: row.dueDate ?? row.due_date,
              amountCents: Number(row.amountCents ?? row.amount_cents ?? 0),
              status: row.status ?? 'PENDING',
            }))
          : installmentsFromTerms.map((i) => ({
              installmentNum: i.installmentNum ?? i.installment_num ?? null,
              dueDate: i.dueDate ?? i.due_date,
              amountCents: i.amountCents ?? i.amount_cents ?? 0,
              status: i.status ?? 'PENDING',
            }));
      const proofKeys = Array.isArray(agreement.paymentProofUrls) ? agreement.paymentProofUrls : [];
      const proofViewUrls = await resolveEvidenceUrls(proofKeys);
      agreementPayload = {
        id: agreement.id,
        totalAmountCents: agreement.totalAmountCents,
        downPaymentCents: agreement.downPaymentCents,
        installments: agreement.installments,
        status: agreement.status,
        type: agreement.type,
        installmentsSchedule,
        paymentProofUrls: proofViewUrls,
      };
    }

    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'name'] });
    const resolved = resolveBranding(brandingRes, tenant);
    const logoUrl = resolved.logoUrl ? await resolveLogoUrl(resolved.logoUrl) : null;

    const evidenceKeys = openDisputeRaw?.evidence_urls ?? openDisputeRaw?.evidenceUrls ?? [];
    const evidenceViewUrls = Array.isArray(evidenceKeys) && evidenceKeys.length > 0 ? await resolveEvidenceUrls(evidenceKeys) : [];

    const payload = {
      debtor: {
        name: debtor?.fullName ?? null,
        unit: unitNumber,
        property: propertyName,
      },
      case: {
        id: dc?.id,
        amountDueCents: dc?.amountDueCents ?? 0,
        daysPastDue: dc?.daysPastDue ?? 0,
        dueDate: dc?.dueDate ?? null,
        status: dc?.status ?? null,
        isCurrentOnPayments,
      },
      branding: {
        companyName: resolved.companyName,
        logoUrl,
        primaryColor: resolved.primaryColor,
        secondaryColor: resolved.secondaryColor,
        supportEmail: resolved.supportEmail,
        supportPhone: resolved.supportPhone,
        supportHours: resolved.supportHours,
        footerText: resolved.footerText,
        showPoweredBy: resolved.showPoweredBy,
      },
      charges: { rent, fees },
      payments,
      agreement: agreementPayload,
      openDispute: openDisputeRaw
        ? {
            id: openDisputeRaw.id,
            reason: openDisputeRaw.reason,
            notes: openDisputeRaw.notes,
            openedAt: openDisputeRaw.openedAt,
            evidenceUrls: evidenceViewUrls,
          }
        : null,
      paymentChannels: paymentInstructions,
    };

    return { status: 200, payload };
  },

  /**
   * POST /pay/:token/dispute — Requires paySessionToken. Create dispute from portal.
   */
  createDispute: async (token, authHeader, body) => {
    const decoded = verifyPaySession(authHeader?.replace(/^Bearer\s+/i, '')?.trim());
    if (!decoded) return { status: 401, message: 'Invalid or expired session' };

    const link = await resolvePaymentLink(token, {
      include: [{ model: DebtCase, as: 'debtCase', attributes: ['id', 'tenantId'] }],
    });

    if (!link) return { status: 404 };
    if (decoded.payToken !== link.token) return { status: 401, message: 'Invalid or expired session' };
    if (link.status !== 'VERIFIED' && link.status !== 'PENDING') {
      if (link.status === 'PAID') return { status: 410 };
      if (link.status === 'EXPIRED' || link.status === 'BLOCKED') return { status: 410 };
    }

    const { reason, notes, evidenceKeys } = body || {};
    const validReasons = [
      'PAID_ALREADY',
      'WRONG_AMOUNT',
      'WRONG_DEBTOR',
      'LEASE_ENDED',
      'UNDER_LEGAL_REVIEW',
      'PROMISE_OFFLINE',
      'DO_NOT_CONTACT',
      'OTHER',
    ];
    if (!reason || !validReasons.includes(reason)) {
      return { status: 400, message: 'Invalid or missing reason' };
    }

    const debtCaseId = link.debtCaseId;
    const tenantId = link.tenantId;

    const existing = await CaseDispute.findOne({
      where: { debtCaseId, status: 'OPEN' },
    });
    if (existing) {
      return { status: 409, message: 'An open dispute already exists for this case' };
    }

    const notesTrimmed = typeof notes === 'string' ? notes.slice(0, 500).trim() || null : null;
    const evidenceArr = Array.isArray(evidenceKeys)
      ? evidenceKeys
          .filter((k) => typeof k === 'string' && isOurS3Key(k) && k.startsWith(`disputes/${tenantId}/${debtCaseId}/`))
          .slice(0, 10)
      : [];
    const dispute = await CaseDispute.create({
      tenantId,
      debtCaseId,
      reason,
      notes: notesTrimmed,
      evidenceUrls: evidenceArr,
      openedBy: null,
      openedAt: new Date(),
      status: 'OPEN',
    });

    return {
      status: 200,
      payload: {
        success: true,
        dispute: {
          id: dispute.id,
          reason: dispute.reason,
          openedAt: dispute.openedAt,
        },
      },
    };
  },

  /**
   * POST /pay/:token/otp/send — Send OTP to debtor's email (preferred) or phone. Identity verification.
   */
  sendOtp: async (token) => {
    const link = await resolvePaymentLink(token, {
      include: [
        { model: DebtCase, as: 'debtCase', include: [{ model: Debtor, as: 'debtor' }] },
        { model: Tenant, as: 'tenant', attributes: ['id', 'name'] },
      ],
    });

    if (!link) return { status: 404 };
    if (link.status === 'BLOCKED') return { status: 423 };
    if (link.status === 'PAID') return { status: 410 };
    if (link.status === 'EXPIRED' || (link.expiresAt && new Date(link.expiresAt) < new Date())) {
      if (link.status !== 'EXPIRED') await link.update({ status: 'EXPIRED' });
      return { status: 410 };
    }
    if (link.status === 'VERIFIED') {
      const paySessionToken = signPaySession(link.token);
      const urlToken = link.shortToken || link.token;
      return { status: 200, payload: { verified: true, token: urlToken, paySessionToken } };
    }

    const debtor = link.debtCase?.debtor;
    const email = debtor?.email?.trim();
    const phone = debtor?.phone?.trim();
    if (!email && !phone) return { status: 400, message: 'No email or phone on file for this account' };

    const maxOtpAttempts = 5;
    if (link.otpAttempts >= maxOtpAttempts) {
      await link.update({ status: 'BLOCKED' });
      return { status: 429, message: 'Too many OTP attempts' };
    }

    const branding = await TenantBranding.findOne({ where: { tenantId: link.tenantId } });
    const tenant = link.tenant || (await Tenant.findByPk(link.tenantId, { attributes: ['id', 'name'] }));
    const resolved = resolveBranding(branding, tenant);
    const companyName = resolved.companyName || 'Mordecai';

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    const otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    let sendTo = null;
    let maskedDestination = null;

    if (email) {
      try {
        await sendOtpEmail(email, code, companyName);
        sendTo = email;
        maskedDestination = maskEmail(email);
      } catch (err) {
        logger.warn({ err, token }, 'Pay OTP email send failed, trying SMS fallback');
        if (phone) {
          try {
            await sendTwilioSms({
              to: phone,
              body: `Your verification code is: ${code}. It expires in 15 minutes.`,
            });
            sendTo = phone;
            maskedDestination = 'your phone';
          } catch (smsErr) {
            logger.warn({ err: smsErr, token }, 'Pay OTP SMS fallback failed');
            return { status: 503, message: 'Failed to send verification code' };
          }
        } else {
          return { status: 503, message: 'Failed to send verification code' };
        }
      }
    } else {
      try {
        await sendTwilioSms({
          to: phone,
          body: `Your verification code is: ${code}. It expires in 15 minutes.`,
        });
        sendTo = phone;
        maskedDestination = 'your phone';
      } catch (err) {
        logger.warn({ err, token }, 'Pay OTP send failed');
        return { status: 503, message: 'Failed to send verification code' };
      }
    }

    await link.update({
      otpCodeHash: hash,
      otpExpiresAt,
      otpSentTo: sendTo,
      otpAttempts: (link.otpAttempts || 0) + 1,
    });

    return { status: 200, payload: { sent: true, expiresIn: 900, maskedDestination } };
  },

  /**
   * POST /pay/:token/otp/verify — Verify OTP code. On success: VERIFIED + paySessionToken.
   */
  verifyOtp: async (token, body) => {
    const { code } = body || {};
    const link = await resolvePaymentLink(token);

    if (!link) return { status: 404 };
    if (link.status === 'BLOCKED') return { status: 423 };
    if (link.status === 'PAID') return { status: 410 };
    if (link.status === 'EXPIRED' || (link.expiresAt && new Date(link.expiresAt) < new Date())) {
      if (link.status !== 'EXPIRED') await link.update({ status: 'EXPIRED' });
      return { status: 410 };
    }
    if (link.status === 'VERIFIED') {
      const paySessionToken = signPaySession(link.token);
      const urlToken = link.shortToken || link.token;
      return { status: 200, payload: { verified: true, token: urlToken, paySessionToken } };
    }

    const maxOtpAttempts = 5;
    if (link.otpAttempts >= maxOtpAttempts) {
      await link.update({ status: 'BLOCKED' });
      return { status: 429, message: 'Too many OTP attempts' };
    }

    if (!link.otpCodeHash || !link.otpExpiresAt) {
      return { status: 400, message: 'No OTP sent. Request one first.' };
    }
    if (new Date(link.otpExpiresAt) < new Date()) {
      return { status: 400, message: 'OTP expired. Request a new one.' };
    }

    const inputHash = crypto.createHash('sha256').update(String(code ?? '').trim()).digest('hex');
    if (inputHash !== link.otpCodeHash) {
      await link.increment('otpAttempts');
      return { status: 401, message: 'Invalid verification code' };
    }

    await link.update({
      status: 'VERIFIED',
      verifiedAt: new Date(),
      verificationMethod: 'OTP',
      otpCodeHash: null,
      otpExpiresAt: null,
    });

    const paySessionToken = signPaySession(link.token);
    const urlToken = link.shortToken || link.token;
    return {
      status: 200,
      payload: { verified: true, token: urlToken, paySessionToken },
    };
  },

  /**
   * POST /pay/:token/dispute/evidence/presign — Get presigned upload URL for dispute evidence.
   */
  presignDisputeEvidence: async (token, authHeader, body) => {
    const decoded = verifyPaySession(authHeader?.replace(/^Bearer\s+/i, '')?.trim());
    if (!decoded) return { status: 401, message: 'Invalid or expired session' };

    const link = await resolvePaymentLink(token, {
      include: [{ model: DebtCase, as: 'debtCase', attributes: ['id', 'tenantId'] }],
    });
    if (!link) return { status: 404 };
    if (decoded.payToken !== link.token) return { status: 401, message: 'Invalid or expired session' };
    if (link.status !== 'VERIFIED' && link.status !== 'PENDING') return { status: 410 };

    const { filename, contentType } = body || {};
    if (!filename || !contentType) return { status: 400, message: 'filename and contentType required' };

    const { uploadUrl, s3Key, expiresIn } = await generatePresignedUploadUrl({
      tenantId: link.tenantId,
      debtCaseId: link.debtCaseId,
      filename,
      contentType,
    });
    return { status: 200, payload: { uploadUrl, s3Key, expiresIn } };
  },

  /**
   * POST /pay/:token/dispute/evidence — Add evidence (s3Keys) to existing open dispute.
   */
  addDisputeEvidence: async (token, authHeader, body) => {
    const decoded = verifyPaySession(authHeader?.replace(/^Bearer\s+/i, '')?.trim());
    if (!decoded) return { status: 401, message: 'Invalid or expired session' };

    const link = await resolvePaymentLink(token, {
      include: [{ model: DebtCase, as: 'debtCase', attributes: ['id', 'tenantId'] }],
    });
    if (!link) return { status: 404 };
    if (decoded.payToken !== link.token) return { status: 401, message: 'Invalid or expired session' };
    if (link.status !== 'VERIFIED' && link.status !== 'PENDING') return { status: 410 };

    const dispute = await CaseDispute.findOne({
      where: { debtCaseId: link.debtCaseId, status: 'OPEN' },
    });
    if (!dispute) return { status: 404, message: 'No open dispute found for this case' };

    const { evidenceKeys } = body || {};
    const keys = Array.isArray(evidenceKeys)
      ? evidenceKeys
          .filter((k) => typeof k === 'string' && isOurS3Key(k) && k.startsWith(`disputes/${link.tenantId}/${link.debtCaseId}/`))
          .slice(0, 10)
      : [];
    const existing = Array.isArray(dispute.evidenceUrls) ? dispute.evidenceUrls : [];
    const merged = [...existing, ...keys].slice(0, 20);
    await dispute.update({ evidenceUrls: merged });

    return { status: 200, payload: { success: true, evidenceCount: merged.length } };
  },

  /**
   * POST /pay/:token/agreement/proof/presign — Get presigned upload URL for agreement payment proof.
   */
  presignAgreementProof: async (token, authHeader, body) => {
    const decoded = verifyPaySession(authHeader?.replace(/^Bearer\s+/i, '')?.trim());
    if (!decoded) return { status: 401, message: 'Invalid or expired session' };

    const link = await resolvePaymentLink(token, {
      include: [
        { model: DebtCase, as: 'debtCase', attributes: ['id'] },
        { model: PaymentAgreement, as: 'paymentAgreement', required: false, attributes: ['id'] },
      ],
    });
    if (!link) return { status: 404 };
    if (decoded.payToken !== link.token) return { status: 401, message: 'Invalid or expired session' };
    if (link.status !== 'VERIFIED' && link.status !== 'PENDING') return { status: 410 };
    const agreement = link.paymentAgreement;
    if (!agreement) return { status: 404, message: 'No agreement linked to this payment link' };

    const { filename, contentType } = body || {};
    if (!filename || !contentType) return { status: 400, message: 'filename and contentType required' };

    const { uploadUrl, s3Key, expiresIn } = await generatePresignedUploadUrl({
      tenantId: link.tenantId,
      debtCaseId: link.debtCaseId,
      agreementId: agreement.id,
      filename,
      contentType,
    });
    return { status: 200, payload: { uploadUrl, s3Key, expiresIn } };
  },

  /**
   * POST /pay/:token/agreement/proof — Add payment proof (s3Keys) to agreement.
   */
  addAgreementProof: async (token, authHeader, body) => {
    const decoded = verifyPaySession(authHeader?.replace(/^Bearer\s+/i, '')?.trim());
    if (!decoded) return { status: 401, message: 'Invalid or expired session' };

    const link = await resolvePaymentLink(token, {
      include: [{ model: PaymentAgreement, as: 'paymentAgreement', required: false, attributes: ['id'] }],
    });
    if (!link) return { status: 404 };
    if (decoded.payToken !== link.token) return { status: 401, message: 'Invalid or expired session' };
    if (link.status !== 'VERIFIED' && link.status !== 'PENDING') return { status: 410 };
    const agreement = link.paymentAgreement;
    if (!agreement) return { status: 404, message: 'No agreement linked to this payment link' };

    const { proofKeys } = body || {};
    const keys = Array.isArray(proofKeys)
      ? proofKeys
          .filter((k) => typeof k === 'string' && isOurS3Key(k) && k.startsWith(`agreements/${link.tenantId}/${agreement.id}/`))
          .slice(0, 10)
      : [];
    const existing = Array.isArray(agreement.paymentProofUrls) ? agreement.paymentProofUrls : [];
    const merged = [...existing, ...keys].slice(0, 20);
    await agreement.update({ paymentProofUrls: merged });

    return { status: 200, payload: { success: true, proofCount: merged.length } };
  },

  /**
   * POST /pay/:token/dispute/evidence/upload — Upload dispute evidence file (multipart). Server uploads to S3 and adds key to dispute.
   */
  uploadDisputeEvidence: async (token, authHeader, file) => {
    const decoded = verifyPaySession(authHeader?.replace(/^Bearer\s+/i, '')?.trim());
    if (!decoded) return { status: 401, message: 'Invalid or expired session' };

    const link = await resolvePaymentLink(token, {
      include: [{ model: DebtCase, as: 'debtCase', attributes: ['id', 'tenantId'] }],
    });
    if (!link) return { status: 404 };
    if (decoded.payToken !== link.token) return { status: 401, message: 'Invalid or expired session' };
    if (link.status !== 'VERIFIED' && link.status !== 'PENDING') return { status: 410 };

    const dispute = await CaseDispute.findOne({
      where: { debtCaseId: link.debtCaseId, status: 'OPEN' },
    });
    if (!dispute) return { status: 404, message: 'No open dispute found for this case' };

    if (!file?.path) return { status: 400, message: 'No file provided' };

    try {
      const s3Key = await s3UploadDisputeEvidence(
        link.tenantId,
        link.debtCaseId,
        file.path,
        file.originalname || 'file',
        file.mimetype || 'application/octet-stream'
      );
      const existing = Array.isArray(dispute.evidenceUrls) ? dispute.evidenceUrls : [];
      const merged = [...existing, s3Key].slice(0, 20);
      await dispute.update({ evidenceUrls: merged });
      return { status: 200, payload: { success: true, s3Key, evidenceCount: merged.length } };
    } catch (err) {
      return { status: 400, message: err.message || 'Upload failed' };
    }
  },

  /**
   * POST /pay/:token/agreement/proof/upload — Upload agreement payment proof file (multipart). Server uploads to S3 and adds key to agreement.
   */
  uploadAgreementProof: async (token, authHeader, file) => {
    const decoded = verifyPaySession(authHeader?.replace(/^Bearer\s+/i, '')?.trim());
    if (!decoded) return { status: 401, message: 'Invalid or expired session' };

    const link = await resolvePaymentLink(token, {
      include: [{ model: PaymentAgreement, as: 'paymentAgreement', required: false, attributes: ['id'] }],
    });
    if (!link) return { status: 404 };
    if (decoded.payToken !== link.token) return { status: 401, message: 'Invalid or expired session' };
    if (link.status !== 'VERIFIED' && link.status !== 'PENDING') return { status: 410 };
    const agreement = link.paymentAgreement;
    if (!agreement) return { status: 404, message: 'No agreement linked to this payment link' };

    if (!file?.path) return { status: 400, message: 'No file provided' };

    try {
      const s3Key = await s3UploadAgreementProof(
        link.tenantId,
        agreement.id,
        file.path,
        file.originalname || 'file',
        file.mimetype || 'application/octet-stream'
      );
      const existing = Array.isArray(agreement.paymentProofUrls) ? agreement.paymentProofUrls : [];
      const merged = [...existing, s3Key].slice(0, 20);
      await agreement.update({ paymentProofUrls: merged });
      return { status: 200, payload: { success: true, s3Key, proofCount: merged.length } };
    } catch (err) {
      return { status: 400, message: err.message || 'Upload failed' };
    }
  },
};
