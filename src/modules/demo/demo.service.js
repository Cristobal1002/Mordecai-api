import crypto from 'crypto';
import { ForbiddenError } from '../../errors/index.js';
import {
  DebtCase,
  Debtor,
  FlowPolicy,
  InteractionLog,
  Tenant,
} from '../../models/index.js';
import { getAuthIdentity } from '../../utils/auth-identity.js';
import { createVoiceContextSignature } from '../twilio/calls/context-signature.js';
import { sendTwilioSms } from '../twilio/sms/twilio.sms.client.js';
import { buildConciseLinkSmsBody } from '../twilio/sms/twilio.sms.template.js';
import { sendSesEmail } from '../email/ses/ses.email.client.js';
import { renderElevenLinkEmail } from '../email/ses/ses.email.template.js';
import { getOrCreatePaymentLinkUrl } from '../pay/payment-link-resolver.service.js';

const DEFAULT_RULES = {
  min_upfront_pct: 25,
  half_pct: 50,
  max_installments: 4,
};

const DEFAULT_ALLOWED_PLANS = ['full', 'half', 'installments_4'];
const DEFAULT_ALLOWED_PAYMENT_CHANNELS = ['link', 'card'];

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const buildChannels = () => ({
  sms: true,
  email: true,
  call: true,
  whatsapp: false,
});

const parseAmountUsdToCents = (value) => {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.round(normalized * 100);
};

const normalizePhone = (value) => String(value || '').replace(/[^\d+]/g, '');
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

const buildDemoInteractionLog = async ({
  tenantId,
  debtCaseId,
  debtorId,
  type,
  status = 'queued',
  providerRef = null,
  summary = null,
  outcome = null,
  error = null,
  aiData = {},
}) =>
  InteractionLog.create({
    tenantId,
    debtCaseId,
    debtorId,
    type,
    direction: 'OUTBOUND',
    channelProvider: type === 'SMS' ? 'twilio' : 'ses',
    status,
    providerRef,
    summary,
    outcome,
    error,
    startedAt: new Date(),
    endedAt: ['sent', 'failed'].includes(String(status || '').toLowerCase())
      ? new Date()
      : null,
    aiData,
  });

const normalizeDemoPlanCodes = (options = []) => {
  const normalized = Array.isArray(options)
    ? options
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
    : [];

  return normalized.length > 0 ? normalized : DEFAULT_ALLOWED_PLANS;
};

const normalizeDemoPaymentChannels = (channels = []) => {
  const normalized = Array.isArray(channels)
    ? channels
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
    : [];

  return normalized.length > 0 ? normalized : DEFAULT_ALLOWED_PAYMENT_CHANNELS;
};

const buildDemoFlowPolicyRules = (input, baseRules = {}) => ({
  ...DEFAULT_RULES,
  ...(baseRules || {}),
  allowed_plans: normalizeDemoPlanCodes(input.options),
  payment_channels: normalizeDemoPaymentChannels(input.channels),
  opening_message: input.openingMessage || '',
  tenant_display_name: input.tenantDisplayName || '',
});

const buildDemoFlowPolicyName = ({ basePolicy, input }) => {
  const fingerprint = crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        min: basePolicy?.minDaysPastDue ?? null,
        max: basePolicy?.maxDaysPastDue ?? null,
        tone: basePolicy?.tone ?? 'professional',
        options: normalizeDemoPlanCodes(input.options),
        channels: normalizeDemoPaymentChannels(input.channels),
        openingMessage: input.openingMessage || '',
        tenantDisplayName: input.tenantDisplayName || '',
      })
    )
    .digest('hex')
    .slice(0, 10);

  return `Demo runtime policy ${fingerprint}`.slice(0, 120);
};

const resolveDemoFlowPolicy = async ({ tenantId, basePolicy, input }) => {
  const runtimeName = buildDemoFlowPolicyName({ basePolicy, input });
  const existing = await FlowPolicy.findOne({
    where: {
      tenantId,
      name: runtimeName,
      minDaysPastDue: basePolicy.minDaysPastDue,
      maxDaysPastDue: basePolicy.maxDaysPastDue,
    },
  });

  if (existing) return existing;

  return FlowPolicy.create({
    tenantId,
    name: runtimeName,
    minDaysPastDue: basePolicy.minDaysPastDue,
    maxDaysPastDue: basePolicy.maxDaysPastDue,
    channels: basePolicy.channels || buildChannels(),
    tone: basePolicy.tone || 'professional',
    rules: buildDemoFlowPolicyRules(input, basePolicy.rules || {}),
    isActive: true,
  });
};

const sendDemoLinkSms = async ({ tenant, debtor, debtCase }) => {
  const to = String(debtor?.phone || '').trim();
  if (!to) {
    return {
      ok: false,
      channel: 'sms',
      outcome: 'sms_invalid_contact',
      message: 'Debtor phone is missing.',
    };
  }

  const paymentLinkUrl = await getOrCreatePaymentLinkUrl({
    tenantId: tenant.id,
    debtCaseId: debtCase.id,
    includeAttribution: false,
  });

  const body = buildConciseLinkSmsBody({
    debtorName: debtor?.fullName,
    tenantName:
      String(
        debtCase?.meta?.tenant_display_name ||
          debtCase?.meta?.tenant_name ||
          tenant?.name ||
          'Collections'
      ).trim() || 'Collections',
    paymentLink: paymentLinkUrl,
  });

  try {
    const provider = await sendTwilioSms({ to, body });
    const interaction = await buildDemoInteractionLog({
      tenantId: tenant.id,
      debtCaseId: debtCase.id,
      debtorId: debtor.id,
      type: 'SMS',
      status: 'sent',
      providerRef: provider.messageSid,
      summary: body,
      aiData: {
        source: 'demo-ui',
        context: 'demo_link_delivery',
        payment_link_url: paymentLinkUrl,
      },
    });

    return {
      ok: true,
      channel: 'sms',
      outcome: 'sms_sent',
      interactionLogId: interaction.id,
      providerRef: provider.messageSid,
    };
  } catch (error) {
    await buildDemoInteractionLog({
      tenantId: tenant.id,
      debtCaseId: debtCase.id,
      debtorId: debtor.id,
      type: 'SMS',
      status: 'failed',
      summary: 'Demo SMS delivery failed',
      outcome: 'FAILED',
      error: {
        message: error?.message || 'Demo SMS dispatch failed',
      },
      aiData: {
        source: 'demo-ui',
        context: 'demo_link_delivery',
      },
    });

    return {
      ok: false,
      channel: 'sms',
      outcome: 'sms_failed',
      message: error?.message || 'Demo SMS dispatch failed',
    };
  }
};

const sendDemoLinkEmail = async ({ tenant, debtor, debtCase }) => {
  const to = normalizeEmail(debtor?.email);
  if (!to || !isValidEmail(to)) {
    return {
      ok: false,
      channel: 'email',
      outcome: 'email_invalid_contact',
      message: 'Debtor email is missing.',
    };
  }

  const paymentLinkUrl = await getOrCreatePaymentLinkUrl({
    tenantId: tenant.id,
    debtCaseId: debtCase.id,
  });

  const rendered = renderElevenLinkEmail({
    context: 'agreement',
    debtorName: debtor?.fullName || 'there',
    tenantName:
      String(
        debtCase?.meta?.tenant_display_name ||
          debtCase?.meta?.tenant_name ||
          tenant?.name ||
          'Collections'
      ).trim() || 'Collections',
    paymentLinkUrl,
  });

  try {
    const provider = await sendSesEmail({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: [
        { name: 'tenant_id', value: String(tenant.id) },
        { name: 'debt_case_id', value: String(debtCase.id) },
        { name: 'channel', value: 'email' },
        { name: 'source', value: 'demo-ui' },
      ],
    });

    const interaction = await buildDemoInteractionLog({
      tenantId: tenant.id,
      debtCaseId: debtCase.id,
      debtorId: debtor.id,
      type: 'EMAIL',
      status: 'sent',
      providerRef: provider.messageId,
      summary: rendered.text.slice(0, 500),
      aiData: {
        source: 'demo-ui',
        context: 'demo_link_delivery',
        payment_link_url: paymentLinkUrl,
        email: {
          template: rendered.templateName,
          subject: rendered.subject,
        },
      },
    });

    return {
      ok: true,
      channel: 'email',
      outcome: 'email_sent',
      interactionLogId: interaction.id,
      providerRef: provider.messageId,
    };
  } catch (error) {
    await buildDemoInteractionLog({
      tenantId: tenant.id,
      debtCaseId: debtCase.id,
      debtorId: debtor.id,
      type: 'EMAIL',
      status: 'failed',
      summary: 'Demo email delivery failed',
      outcome: 'FAILED',
      error: {
        message: error?.message || 'Demo email dispatch failed',
      },
      aiData: {
        source: 'demo-ui',
        context: 'demo_link_delivery',
      },
    });

    return {
      ok: false,
      channel: 'email',
      outcome: 'email_failed',
      message: error?.message || 'Demo email dispatch failed',
    };
  }
};

const getTwilioConfig = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const voiceUrl = process.env.TWILIO_VOICE_URL;
  const contextHmacSecret = process.env.CALL_CONTEXT_HMAC_SECRET;

  if (!accountSid || !authToken || !fromNumber || !voiceUrl || !contextHmacSecret) {
    throw new Error(
      'Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_VOICE_URL, or CALL_CONTEXT_HMAC_SECRET'
    );
  }

  return {
    accountSid,
    authToken,
    fromNumber,
    voiceUrl,
    contextHmacSecret,
    signatureVersion: process.env.CALL_CONTEXT_SIGNATURE_VERSION || '1',
    ttlSeconds: Number(process.env.CALL_CONTEXT_TTL_SECONDS) || 600,
  };
};

const createTwilioCall = async ({ to, from, voiceUrl, accountSid, authToken }) => {
  const params = new URLSearchParams({
    To: to,
    From: from,
    Url: voiceUrl,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twilio call failed: ${response.status} ${body}`);
  }

  const json = await response.json();
  return json.sid;
};

const resolveDemoTenant = async () => {
  const tenantIdFromEnv = process.env.DEMO_TENANT_ID;
  if (tenantIdFromEnv) {
    const existingById = await Tenant.findByPk(tenantIdFromEnv);
    if (existingById) return existingById;
  }

  const demoTenantName = process.env.DEMO_TENANT_NAME || 'Mordecai Demo Tenant';
  const [tenant] = await Tenant.findOrCreate({
    where: { name: demoTenantName },
    defaults: {
      timezone: 'America/New_York',
      status: 'active',
      settings: { demo: true },
    },
  });

  return tenant;
};

const ensureFlowPolicies = async (tenantId) => {
  const existing = await FlowPolicy.findAll({
    where: { tenantId, isActive: true },
    order: [['minDaysPastDue', 'ASC']],
  });

  if (existing.length >= 3) return existing;

  const presets = [
    { name: 'Demo 1-5 days', min: 1, max: 5, tone: 'friendly' },
    { name: 'Demo 6-20 days', min: 6, max: 20, tone: 'professional' },
    { name: 'Demo 21+ days', min: 21, max: null, tone: 'firm' },
  ];

  const created = [];
  for (const preset of presets) {
    const [policy] = await FlowPolicy.findOrCreate({
      where: {
        tenantId,
        minDaysPastDue: preset.min,
        maxDaysPastDue: preset.max,
      },
      defaults: {
        name: preset.name,
        channels: buildChannels(),
        tone: preset.tone,
        rules: DEFAULT_RULES,
        isActive: true,
      },
    });
    created.push(policy);
  }

  return created;
};

const selectFlowPolicy = (flowPolicies, daysPastDue) => {
  const sorted = [...flowPolicies].sort(
    (left, right) => Number(left.minDaysPastDue) - Number(right.minDaysPastDue)
  );

  const match = sorted.find((policy) => {
    const min = Number(policy.minDaysPastDue);
    const max =
      policy.maxDaysPastDue === null || policy.maxDaysPastDue === undefined
        ? Number.POSITIVE_INFINITY
        : Number(policy.maxDaysPastDue);
    return daysPastDue >= min && daysPastDue <= max;
  });

  return match || sorted[0] || null;
};

const buildSignedVoiceUrl = ({
  baseVoiceUrl,
  interactionId,
  tenantId,
  caseId,
  contextHmacSecret,
  signatureVersion,
  ttlSeconds,
}) => {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createVoiceContextSignature({
    interactionId,
    tenantId,
    caseId,
    exp,
    version: signatureVersion,
    secret: contextHmacSecret,
  });

  const url = new URL(baseVoiceUrl);
  url.searchParams.set('il', interactionId);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('v', signatureVersion);
  url.searchParams.set('sig', sig);
  return url.toString();
};

const validateStartCallPayload = (payload = {}) => {
  const name = String(payload.name || '').trim();
  const phone = normalizePhone(payload.phone);
  const amountCents = parseAmountUsdToCents(payload.amountUsd);
  const daysPastDue = Number(payload.daysPastDue ?? 12);
  const tenantDisplayName = payload.tenantDisplayName
    ? String(payload.tenantDisplayName).trim().slice(0, 200)
    : '';

  if (!name) return { ok: false, message: 'name is required' };
  if (!phone || phone.length < 8) return { ok: false, message: 'phone must be valid E.164' };
  if (!amountCents) return { ok: false, message: 'amountUsd must be a positive number' };
  if (!tenantDisplayName) return { ok: false, message: 'tenantDisplayName is required' };
  if (!Number.isFinite(daysPastDue) || daysPastDue < 0) {
    return { ok: false, message: 'daysPastDue must be >= 0' };
  }

  return {
    ok: true,
    normalized: {
      name,
      phone,
      email: payload.email ? normalizeEmail(payload.email) : null,
      amountCents,
      daysPastDue: Math.round(daysPastDue),
      dueDate: payload.dueDate || null,
      options: Array.isArray(payload.options) ? payload.options : [],
      channels: Array.isArray(payload.channels) ? payload.channels : [],
      useCase: payload.useCase ? String(payload.useCase).trim() : '',
      openingMessage: payload.openingMessage
        ? String(payload.openingMessage).trim().slice(0, 2000)
        : '',
      tenantDisplayName,
    },
  };
};

const clampListLimit = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(numeric)));
};

const toStringArray = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const toNumberOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const buildDemoCaseContext = async (input) => {
  const tenant = await resolveDemoTenant();
  const effectiveTenantDisplayName = input.tenantDisplayName || tenant.name;
  const flowPolicies = await ensureFlowPolicies(tenant.id);
  const baseFlowPolicy = selectFlowPolicy(flowPolicies, input.daysPastDue);

  if (!baseFlowPolicy) {
    return {
      ok: false,
      status: 500,
      message: 'Could not resolve a flow policy for demo interaction.',
    };
  }

  const flowPolicy = await resolveDemoFlowPolicy({
    tenantId: tenant.id,
    basePolicy: baseFlowPolicy,
    input,
  });

  const [debtor] = await Debtor.findOrCreate({
    where: { tenantId: tenant.id, phone: input.phone },
    defaults: {
      fullName: input.name,
      email: input.email,
      metadata: {
        source: 'demo-ui',
      },
    },
  });

  if (debtor.fullName !== input.name || (input.email && debtor.email !== input.email)) {
    await debtor.update({
      fullName: input.name,
      email: input.email || debtor.email,
      metadata: {
        ...(debtor.metadata || {}),
        source: 'demo-ui',
      },
    });
  }

  const debtCase = await DebtCase.create({
    tenantId: tenant.id,
    debtorId: debtor.id,
    flowPolicyId: flowPolicy.id,
    amountDueCents: input.amountCents,
    currency: 'USD',
    daysPastDue: input.daysPastDue,
    dueDate: input.dueDate,
    status: 'IN_PROGRESS',
    mordecaiOperationalActive: true,
    nextActionAt: new Date(),
    meta: {
      source: 'demo-ui',
      customer_name: input.name,
      balance_amount: String(input.amountCents / 100),
      balance_amount_cents: String(input.amountCents),
      options: input.options,
      channels: input.channels,
      use_case: input.useCase,
      opening_message: input.openingMessage,
      tenant_name: effectiveTenantDisplayName,
      tenant_display_name: effectiveTenantDisplayName,
    },
  });

  return { ok: true, tenant, debtor, debtCase };
};

export const startDemoCall = async (payload) => {
  const validation = validateStartCallPayload(payload);
  if (!validation.ok) {
    return { ok: false, status: 400, message: validation.message };
  }

  const input = validation.normalized;
  const context = await buildDemoCaseContext(input);
  if (!context.ok) {
    return context;
  }

  const { tenant, debtor, debtCase } = context;

  const interaction = await InteractionLog.create({
    tenantId: tenant.id,
    debtCaseId: debtCase.id,
    debtorId: debtor.id,
    type: 'CALL',
    direction: 'OUTBOUND',
    channelProvider: 'twilio',
    status: 'queued',
    startedAt: new Date(),
  });

  const twilioConfig = getTwilioConfig();
  const signedVoiceUrl = buildSignedVoiceUrl({
    baseVoiceUrl: twilioConfig.voiceUrl,
    interactionId: interaction.id,
    tenantId: tenant.id,
    caseId: debtCase.id,
    contextHmacSecret: twilioConfig.contextHmacSecret,
    signatureVersion: twilioConfig.signatureVersion,
    ttlSeconds: twilioConfig.ttlSeconds,
  });

  try {
    // TODO(mordecai): revisar arquitectura de disparo de llamadas.
    // Hoy el demo llama Twilio directamente desde API para respuesta inmediata.
    // En una fase futura decidir si unificamos este flujo en workers (cola) o lo mantenemos en backend.
    const callSid = await createTwilioCall({
      to: input.phone,
      from: twilioConfig.fromNumber,
      voiceUrl: signedVoiceUrl,
      accountSid: twilioConfig.accountSid,
      authToken: twilioConfig.authToken,
    });

    await interaction.update({
      providerRef: callSid,
      status: 'in_progress',
      channelProvider: 'twilio',
    });

    return {
      ok: true,
      status: 201,
      data: {
        callSid,
        tenantId: tenant.id,
        debtorId: debtor.id,
        debtCaseId: debtCase.id,
        interactionId: interaction.id,
        to: input.phone,
        amountDueCents: input.amountCents,
      },
    };
  } catch (error) {
    await interaction.update({
      status: 'failed',
      outcome: 'FAILED',
      endedAt: new Date(),
      error: {
        message: error?.message || 'Twilio call failed',
      },
    });

    return {
      ok: false,
      status: 502,
      message: error?.message || 'Failed to create Twilio call',
    };
  }
};

export const startDemoSms = async (payload) => {
  const validation = validateStartCallPayload(payload);
  if (!validation.ok) {
    return { ok: false, status: 400, message: validation.message };
  }

  const input = validation.normalized;
  const context = await buildDemoCaseContext(input);
  if (!context.ok) {
    return context;
  }

  const { tenant, debtor, debtCase } = context;

  const smsResult = await sendDemoLinkSms({
    tenant,
    debtor,
    debtCase,
  });

  if (!smsResult?.ok) {
    return {
      ok: false,
      status: 502,
      message: smsResult?.message || 'Failed to send Twilio SMS',
    };
  }

  await debtCase.update({
    status: 'CONTACTED',
    lastContactedAt: new Date(),
  });

  return {
    ok: true,
    status: 201,
    data: {
      messageSid: smsResult.providerRef || null,
      tenantId: tenant.id,
      debtorId: debtor.id,
      debtCaseId: debtCase.id,
      interactionId: smsResult.interactionLogId || null,
      to: input.phone,
      amountDueCents: input.amountCents,
    },
  };
};

export const startDemoEmail = async (payload) => {
  const validation = validateStartCallPayload(payload);
  if (!validation.ok) {
    return { ok: false, status: 400, message: validation.message };
  }

  const input = validation.normalized;
  if (!input.email || !isValidEmail(input.email)) {
    return { ok: false, status: 400, message: 'email must be valid' };
  }

  const context = await buildDemoCaseContext(input);
  if (!context.ok) {
    return context;
  }

  const { tenant, debtor, debtCase } = context;
  const emailResult = await sendDemoLinkEmail({
    tenant,
    debtor,
    debtCase,
  });

  if (!emailResult?.ok) {
    return {
      ok: false,
      status: 502,
      message: emailResult?.message || 'Failed to send demo email',
    };
  }

  await debtCase.update({
    status: 'CONTACTED',
    lastContactedAt: new Date(),
  });

  return {
    ok: true,
    status: 201,
    data: {
      messageId: emailResult.providerRef || null,
      tenantId: tenant.id,
      debtorId: debtor.id,
      debtCaseId: debtCase.id,
      interactionId: emailResult.interactionLogId || null,
      to: input.email,
      amountDueCents: input.amountCents,
    },
  };
};

export const listDemoCallsForUser = async ({ req, limit }) => {
  const identity = getAuthIdentity(req);
  if (!identity?.sub && !identity?.email) {
    throw new ForbiddenError('Unauthorized');
  }

  const safeLimit = clampListLimit(limit);
  const interactionRows = await InteractionLog.findAll({
    where: {
      type: 'CALL',
    },
    include: [
      {
        model: DebtCase,
        as: 'debtCase',
        attributes: ['id', 'amountDueCents', 'currency', 'meta'],
        include: [
          {
            model: Debtor,
            as: 'debtor',
            attributes: ['id', 'fullName', 'phone', 'email'],
          },
        ],
      },
    ],
    order: [['createdAt', 'DESC']],
    // Pull an extra buffer, then filter to demo-originated interactions.
    limit: Math.min(MAX_LIST_LIMIT * 3, safeLimit * 3),
  });

  const demoRows = interactionRows
    .filter((interaction) => interaction.debtCase?.meta?.source === 'demo-ui')
    .slice(0, safeLimit);

  return demoRows.map((interaction) => {
    const debtCase = interaction.debtCase;
    const debtor = debtCase?.debtor;
    const caseMeta = debtCase?.meta || {};
    const aiData = interaction.aiData || {};
    const elevenData = aiData.eleven || {};
    const elevenMetadata = elevenData.metadata || {};
    const providerRef = interaction.providerRef || null;

    return {
      interactionId: interaction.id,
      tenantId: interaction.tenantId,
      debtCaseId: interaction.debtCaseId,
      debtorId: interaction.debtorId,
      customerName: debtor?.fullName || caseMeta.customer_name || null,
      phone: debtor?.phone || null,
      amountDueCents: toNumberOrNull(debtCase?.amountDueCents),
      currency: debtCase?.currency || 'USD',
      status: interaction.status,
      outcome: interaction.outcome,
      summary:
        interaction.summary ||
        elevenData?.analysis?.transcript_summary ||
        null,
      useCase: caseMeta.use_case || null,
      paymentOptions: toStringArray(caseMeta.options),
      paymentChannels: toStringArray(caseMeta.channels),
      callSid:
        elevenData.call_sid || (providerRef && String(providerRef).startsWith('CA') ? providerRef : null),
      conversationId:
        elevenData.conversation_id ||
        (providerRef && String(providerRef).startsWith('conv_') ? providerRef : null),
      s3Key: elevenData.s3_key || null,
      callDurationSecs: toNumberOrNull(elevenMetadata.call_duration_secs),
      terminationReason: elevenMetadata.termination_reason || null,
      startedAt: interaction.startedAt || null,
      endedAt: interaction.endedAt || null,
      createdAt: interaction.createdAt || null,
      updatedAt: interaction.updatedAt || null,
    };
  });
};
