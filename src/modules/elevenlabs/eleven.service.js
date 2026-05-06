import crypto from "crypto";
import { Op } from "sequelize";
import {
  DebtCase,
  Debtor,
  FlowPolicy,
  InteractionLog,
  PaymentAgreement,
  CaseDispute,
  CaseAutomationState,
  CollectionEvent,
  Tenant,
} from "../../models/index.js";
import { sequelize } from "../../config/database.js";
import {
  supersedeOperationalAgreementsForCase,
  createInstallmentRowsForAgreement,
  buildAgreementContextDynamicVariables,
} from "../payment-agreements/payment-agreement-lifecycle.service.js";
import { resolvePolicyForCase } from "../collections/policy-resolver.service.js";
import { buildPaymentInstructions } from "../pay/payment-instructions.service.js";
import {
  appendPaymentLinkAttribution,
  getOrCreatePaymentLinkUrl,
} from "../pay/payment-link-resolver.service.js";
import { sendSesEmail } from "../email/ses/ses.email.client.js";
import { renderElevenLinkEmail } from "../email/ses/ses.email.template.js";
import { sendTwilioSms } from "../twilio/sms/twilio.sms.client.js";
import { buildConciseLinkSmsBody } from "../twilio/sms/twilio.sms.template.js";
import { logger } from "../../utils/logger.js";
import { registerTwilioCallInElevenLabs } from "./eleven.client.js";
import {
  CALL_ACTIONS,
  CALL_STATES,
  normalizeCallState,
} from "./call-state-machine.js";
import {
  getPlanCatalogFromResolvedPolicy,
  isInstallmentsLikePlan,
  normalizePlanCode,
} from "./policy/plan-catalog.service.js";
import {
  NEGOTIATION_CALENDAR_TZ,
  compareIsoYmd,
  computeFirstPaymentWindowFromPolicyRules,
  isTruthyNegotiationFlag,
  toNegotiationDateOnly,
} from "./negotiation-first-payment-window.service.js";

const toDateOnly = toNegotiationDateOnly;

const SUPPORTED_INTERACTION_OUTCOMES = new Set([
  "CONNECTED",
  "NO_ANSWER",
  "VOICEMAIL",
  "FAILED",
  "PROMISE_TO_PAY",
  "PAYMENT_PLAN",
  "PAID",
  "REFUSED",
  "CALLBACK_REQUESTED",
]);

const centsToDisplayAmount = (amountCents) => {
  const amount = Number(amountCents || 0) / 100;
  if (!Number.isFinite(amount)) return "0";
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
};

const PAYMENT_OPTION_LABELS = {
  FULL: "full amount in one payment",
  HALF: "percentage payment now and remainder later",
  INSTALLMENTS: "installments plan",
  INSTALLMENTS_4: "up to 4 installments with minimum upfront",
  full: "full amount in one payment",
  half: "50% now and remainder later",
  installments_4: "up to 4 installments with minimum 25% upfront",
};

const PAYMENT_CHANNEL_LABELS = {
  link: "payment link",
  card: "debit/credit card",
  transfer: "bank transfer",
  zelle: "zelle",
  cash: "cash (physical point)",
  check: "check (mail/drop-off)",
};

const DISPUTE_REASON_ALIASES = {
  PAID_ALREADY: new Set([
    "paid",
    "paid_already",
    "already_paid",
    "payment_made",
    "settled",
  ]),
  WRONG_AMOUNT: new Set([
    "wrong_amount",
    "incorrect_amount",
    "amount_wrong",
    "incorrect_balance",
  ]),
  WRONG_DEBTOR: new Set([
    "wrong_debtor",
    "wrong_person",
    "not_mine",
    "not_me",
    "identity_issue",
    "fraud",
  ]),
  LEASE_ENDED: new Set(["lease_ended", "moved_out", "no_longer_tenant"]),
  UNDER_LEGAL_REVIEW: new Set([
    "legal",
    "under_legal_review",
    "attorney",
    "court",
  ]),
  PROMISE_OFFLINE: new Set(["promise_offline", "offline_promise"]),
  DO_NOT_CONTACT: new Set(["do_not_contact", "stop_contact", "stop_calling"]),
  OTHER: new Set(["other"]),
};

const DISPUTE_REASON_VALUES = new Set(Object.keys(DISPUTE_REASON_ALIASES));
const UUID_V4_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());

const normalizeEmailCandidate = (value) => {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (!email) return null;
  return isValidEmail(email) ? email : null;
};

const resolveTenantDisplayNameForDelivery = async ({
  tenantId,
  debtCase,
  resolvedPolicy = null,
}) => {
  const fromMeta = String(
    debtCase?.meta?.tenant_display_name || debtCase?.meta?.tenant_name || "",
  ).trim();
  if (fromMeta) return fromMeta.slice(0, 200);

  const fromRules = String(
    resolvedPolicy?.rules?.tenant_display_name || "",
  ).trim();
  if (fromRules) return fromRules.slice(0, 200);

  const tenant = await Tenant.findByPk(tenantId, { attributes: ["name"] });
  const fromTenant = String(tenant?.name || "").trim();
  if (fromTenant) return fromTenant.slice(0, 200);

  return "Collections";
};

/**
 * Resolve or create a PaymentLink and return the URL.
 * URL format: {base}/p/{token} — does not expose agreement ID.
 */
const createPaymentLinkAndGetUrl = async ({
  tenantId,
  debtCaseId,
  paymentAgreementId,
}) =>
  getOrCreatePaymentLinkUrl({
    tenantId,
    debtCaseId,
    paymentAgreementId,
  });

const parseAmountCents = (value) => {
  if (value === null || value === undefined) return null;

  // Number input: integers are treated as cents, decimals as currency units.
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value)
      ? Math.round(value)
      : Math.round(value * 100);
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // Keep digits, signs, comma and dot for flexible parsing from LLM payloads.
  const cleaned = raw.replace(/[^\d,.\-]/g, "");
  if (!cleaned) return null;

  // Detect decimal style values like "525.00" or "525,50" => currency units.
  const hasDecimalPart = /[.,]\d{1,2}$/.test(cleaned);
  if (hasDecimalPart) {
    const normalized = cleaned.replace(/,/g, ".");
    const numeric = Number.parseFloat(normalized);
    if (!Number.isFinite(numeric)) return null;
    return Math.round(numeric * 100);
  }

  // Otherwise treat as cents (remove thousand separators).
  const normalizedInteger = cleaned.replace(/[.,]/g, "");
  const numeric = Number(normalizedInteger);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric);
};

const looksLikeIntegerAmount = (value) =>
  typeof value === "string" && /^\d+$/.test(String(value).trim());

const normalizeLikelyDollarAmountCents = ({
  rawValue,
  parsedCents,
  balanceCents,
}) => {
  const parsed = Number(parsedCents || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return parsedCents;
  if (!looksLikeIntegerAmount(rawValue)) return parsedCents;

  const asUnits = Number(String(rawValue).trim());
  if (!Number.isFinite(asUnits) || asUnits <= 0) return parsedCents;

  const scaledToCents = Math.round(asUnits * 100);
  if (!Number.isFinite(scaledToCents) || scaledToCents <= 0) return parsedCents;

  // Heuristic: if parsed value is way below balance, assume model sent dollars not cents.
  if (
    balanceCents > 0 &&
    parsed < Math.ceil(balanceCents * 0.1) &&
    scaledToCents <= balanceCents * 2
  ) {
    return scaledToCents;
  }

  return parsedCents;
};

const normalizeDynamicVariableValue = (value) => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const normalizeSelectionValues = (value, labelsMap = {}) => {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

  const ids = rawItems.map((item) => String(item)).filter(Boolean);
  const human = ids.map((id) => labelsMap[id] || id);

  return {
    ids: ids.join(","),
    human: human.join(", "),
  };
};

const normalizePlanCodes = (value) => {
  const list = Array.isArray(value) ? value : [];
  return list.map((item) => String(item).toUpperCase()).filter(Boolean);
};

const normalizeChannelCodes = (value) => {
  const list = Array.isArray(value) ? value : [];
  return list.map((item) => String(item).toLowerCase()).filter(Boolean);
};

const truncateString = (value, maxLength = 4000) => {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
};

const buildPaymentInstructionSummary = (instructions = []) => {
  const chunks = [];
  for (const channel of instructions) {
    const channelParts = [];
    if (channel.reference?.value) {
      channelParts.push(
        `${channel.reference.label || "Reference"}: ${channel.reference.value}`,
      );
    }
    const fields = Array.isArray(channel.fields) ? channel.fields : [];
    for (const field of fields.slice(0, 8)) {
      if (!field?.label || !field?.value) continue;
      channelParts.push(`${field.label}: ${field.value}`);
    }
    if (channelParts.length === 0) continue;
    chunks.push(`${channel.label || channel.code}: ${channelParts.join("; ")}`);
  }
  return truncateString(chunks.join(" | "), 5000);
};

const buildCaseMetadataDynamicVariables = (meta = {}) => {
  const keys = [
    "notes",
    "lease_id",
    "balance_type",
    "last_payment_date",
    "property_id",
    "unit_number",
    "language",
    "use_case",
    "opening_message",
    "tenant_name",
    "tenant_display_name",
  ];

  const acc = keys.reduce((result, key) => {
    const normalized = normalizeDynamicVariableValue(meta[key]);
    if (!normalized) return result;
    result[key] = normalized;
    return result;
  }, {});

  const paymentOptions = normalizeSelectionValues(
    meta.options,
    PAYMENT_OPTION_LABELS,
  );
  if (paymentOptions.ids) {
    acc.payment_options = paymentOptions.ids;
    acc.payment_options_human = paymentOptions.human;
  }

  const paymentChannels = normalizeSelectionValues(
    meta.channels,
    PAYMENT_CHANNEL_LABELS,
  );
  if (paymentChannels.ids) {
    acc.payment_channels = paymentChannels.ids;
    acc.payment_channels_human = paymentChannels.human;
  }

  return acc;
};

/** Build validation-style rules from resolved policy (single source for v1 and v2). */
const getRulesFromResolvedPolicy = (resolvedPolicy) => {
  const catalog = getPlanCatalogFromResolvedPolicy(resolvedPolicy);
  const pr =
    resolvedPolicy?.rules && typeof resolvedPolicy.rules === "object"
      ? resolvedPolicy.rules
      : {};
  const maxDays = pr.negotiation_first_payment_max_days;
  const deadline = pr.negotiation_first_payment_deadline ?? null;
  const capLastWd =
    pr.negotiation_first_payment_cap_last_weekday_of_month ??
    pr.negotiationFirstPaymentCapLastWeekdayOfMonth;
  return {
    minUpfrontPct: Number(catalog.minUpfrontPct ?? 25),
    halfPct: Number(catalog.halfPct ?? 50),
    maxInstallments: Number(catalog.maxInstallments ?? 4),
    allowedPlanTypes:
      Array.isArray(catalog.allowedPlanTypes) &&
      catalog.allowedPlanTypes.length > 0
        ? catalog.allowedPlanTypes
        : ["FULL", "HALF", "INSTALLMENTS_4"],
    plansByCode: catalog.plansByCode || {},
    negotiationFirstPaymentMaxDays:
      maxDays != null && maxDays !== "" && Number.isFinite(Number(maxDays))
        ? Math.max(0, Math.trunc(Number(maxDays)))
        : null,
    negotiationFirstPaymentDeadline: deadline || null,
    negotiationFirstPaymentCapLastWeekdayOfMonth:
      isTruthyNegotiationFlag(capLastWd),
  };
};

const validateProposalAgainstRules = ({ proposal, balanceCents, rules }) => {
  const planType = normalizePlanCode(
    proposal?.plan_type || proposal?.planType || "",
  );
  const rawUpfrontAmount = proposal?.upfront_amount_cents;
  const parsedUpfrontAmountCents = parseAmountCents(rawUpfrontAmount);
  const upfrontAmountCents = normalizeLikelyDollarAmountCents({
    rawValue: rawUpfrontAmount,
    parsedCents: parsedUpfrontAmountCents,
    balanceCents,
  });
  const installmentsCount = Number(proposal?.installments_count || 0);

  if (!planType) {
    return {
      ok: false,
      code: "MISSING_PLAN_TYPE",
      message: "plan_type is required.",
    };
  }

  const allowed = rules.allowedPlanTypes ?? ["FULL", "HALF", "INSTALLMENTS_4"];
  if (!allowed.includes(planType)) {
    return {
      ok: false,
      code: "INVALID_PLAN_TYPE",
      message: `plan_type must be one of: ${allowed.join(", ")}.`,
    };
  }

  const planConfig = rules.plansByCode?.[planType] || {
    code: planType,
    agreementType: isInstallmentsLikePlan(planType)
      ? "INSTALLMENTS"
      : "PROMISE_TO_PAY",
    requiresInstallments: isInstallmentsLikePlan(planType),
    minUpfrontPct: isInstallmentsLikePlan(planType)
      ? Number(rules.minUpfrontPct || 0)
      : planType === "FULL"
        ? 100
        : planType === "HALF"
          ? Number(rules.halfPct || 0)
          : 0,
    maxInstallments: Number(rules.maxInstallments || 1),
  };

  if (!upfrontAmountCents || upfrontAmountCents <= 0) {
    return {
      ok: false,
      code: "INVALID_UPFRONT_AMOUNT",
      message: "upfront_amount_cents must be greater than zero.",
    };
  }

  const minUpfrontPct = Number(planConfig.minUpfrontPct || 0);
  const minUpfrontAmount = Math.ceil(
    (Math.max(0, minUpfrontPct) / 100) * balanceCents,
  );
  if (minUpfrontAmount > 0 && upfrontAmountCents < minUpfrontAmount) {
    return {
      ok: false,
      code: "RULE_VIOLATION",
      message:
        planType === "FULL"
          ? "FULL plan requires paying the full remaining balance."
          : `Minimum upfront is ${minUpfrontPct}% for this flow policy.`,
      allowed_options: {
        min_upfront_amount_cents: minUpfrontAmount,
        max_installments: Number(
          planConfig.maxInstallments || rules.maxInstallments || 0,
        ),
      },
    };
  }

  if (planConfig.requiresInstallments) {
    const maxInstallments = Number(
      planConfig.maxInstallments || rules.maxInstallments || 0,
    );
    if (!installmentsCount || installmentsCount > maxInstallments) {
      return {
        ok: false,
        code: "RULE_VIOLATION",
        message: `Installments count must be between 1 and ${maxInstallments}.`,
        allowed_options: {
          min_upfront_amount_cents: minUpfrontAmount,
          max_installments: maxInstallments,
        },
      };
    }
  }

  const { minDate, maxDate } = computeFirstPaymentWindowFromPolicyRules(
    {
      negotiation_first_payment_max_days: rules.negotiationFirstPaymentMaxDays,
      negotiation_first_payment_deadline: rules.negotiationFirstPaymentDeadline,
      negotiation_first_payment_cap_last_weekday_of_month:
        rules.negotiationFirstPaymentCapLastWeekdayOfMonth,
    },
    NEGOTIATION_CALENDAR_TZ,
  );

  const firstDue = toDateOnly(
    proposal?.first_due_date || proposal?.firstDueDate,
  );
  if (!firstDue) {
    return {
      ok: false,
      code: "MISSING_FIRST_DUE_DATE",
      message:
        "first_due_date is required as YYYY-MM-DD. Ask when the debtor can pay (first payment or first installment) and pass it in the create-payment-agreement tool.",
      allowed_options: {
        first_payment_earliest_date: minDate,
        first_payment_latest_date: maxDate,
      },
    };
  }
  if (compareIsoYmd(firstDue, minDate) < 0) {
    return {
      ok: false,
      code: "FIRST_DUE_TOO_EARLY",
      message: `first_due_date must be on or after ${minDate} (${NEGOTIATION_CALENDAR_TZ} calendar).`,
      allowed_options: {
        first_payment_earliest_date: minDate,
        first_payment_latest_date: maxDate,
      },
    };
  }
  if (maxDate && compareIsoYmd(firstDue, maxDate) > 0) {
    return {
      ok: false,
      code: "FIRST_DUE_AFTER_MAX",
      message: `first_due_date must be on or before ${maxDate} per collection policy.`,
      allowed_options: {
        first_payment_earliest_date: minDate,
        first_payment_latest_date: maxDate,
      },
    };
  }

  return {
    ok: true,
    planType,
    upfrontAmountCents,
    installmentsCount,
    planConfig,
    firstDueDate: firstDue,
  };
};

const buildAgreementValidationSpeakBack = ({
  validation,
  currency = "USD",
}) => {
  const minUpfront = Number(
    validation?.allowed_options?.min_upfront_amount_cents || 0,
  );
  const maxInstallments = Number(
    validation?.allowed_options?.max_installments || 0,
  );

  if (validation?.code === "INVALID_UPFRONT_AMOUNT") {
    return "I need the upfront amount in cents, digits only. For example, 175000 for 1750 dollars.";
  }

  if (validation?.code === "RULE_VIOLATION" && minUpfront > 0) {
    return (
      `For this plan, minimum upfront is ${centsToDisplayAmount(minUpfront)} ${currency}. ` +
      "Please confirm if you want to proceed with that upfront amount."
    );
  }

  if (validation?.code === "RULE_VIOLATION" && maxInstallments > 0) {
    return `Installments count must be between 1 and ${maxInstallments}. Please confirm a valid installments count.`;
  }

  if (validation?.code === "MISSING_FIRST_DUE_DATE") {
    return "Ask when they can make the first payment, then call the tool again with first_due_date as YYYY-MM-DD.";
  }

  if (validation?.code === "FIRST_DUE_TOO_EARLY") {
    const min = validation?.allowed_options?.first_payment_earliest_date;
    return min
      ? `That date is too soon for our policy. The first payment date must be on or after ${min}. Ask for a later date.`
      : "The first payment date cannot be in the past. Ask when they can pay starting from today.";
  }

  if (validation?.code === "FIRST_DUE_AFTER_MAX") {
    const max = validation?.allowed_options?.first_payment_latest_date;
    return max
      ? `That date is too far out. The latest first payment date we can accept is ${max}. Ask for an earlier date.`
      : "The first payment date is outside the allowed window. Ask for an earlier date.";
  }

  return "I could not create the agreement with the provided values. Please confirm plan details and try again.";
};

const resolvePreferredDeliveryChannel = (proposal = {}) => {
  const candidateRaw =
    proposal?.delivery_channel ||
    proposal?.deliveryChannel ||
    proposal?.preferred_delivery_channel ||
    proposal?.preferredDeliveryChannel ||
    proposal?.send_via ||
    proposal?.sendVia ||
    proposal?.channel ||
    null;

  const candidate = String(candidateRaw || "")
    .trim()
    .toLowerCase();

  if (!candidate) return null;
  if (["email", "mail"].includes(candidate)) return "email";
  if (["sms", "text", "text_message"].includes(candidate)) return "sms";
  if (["both", "all", "email_sms", "sms_email"].includes(candidate))
    return "both";
  return null;
};

const normalizeDisputeReason = (value) => {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (DISPUTE_REASON_VALUES.has(raw)) return raw;

  const normalizedLower = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!normalizedLower) return "OTHER";

  for (const [reason, aliases] of Object.entries(DISPUTE_REASON_ALIASES)) {
    if (aliases.has(normalizedLower)) return reason;
  }

  return "OTHER";
};

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === "")
    return defaultValue;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return defaultValue;
};

const normalizeUuid = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  return UUID_V4_LIKE.test(text) ? text : null;
};

const resolveAutomationIdForCase = async ({
  debtCaseId,
  automationId = null,
}) => {
  const directAutomationId = normalizeUuid(automationId);
  if (directAutomationId) return directAutomationId;

  if (automationId && !directAutomationId) {
    logger.warn(
      { automationId },
      "Ignoring non-UUID automation_id from tool payload; falling back to active state",
    );
  }

  const state = await CaseAutomationState.findOne({
    where: { debtCaseId, status: "active" },
    order: [["updatedAt", "DESC"]],
  });
  return state?.automationId || null;
};

const createCollectionEvent = async ({
  automationId,
  debtCaseId,
  channel,
  eventType,
  payload = {},
}) => {
  if (!automationId) return null;
  return CollectionEvent.create({
    automationId,
    debtCaseId,
    channel,
    eventType,
    payload,
  });
};

const createCallToolEvent = async ({
  debtCaseId,
  automationId,
  eventType,
  payload = {},
}) => {
  const resolvedAutomationId = await resolveAutomationIdForCase({
    debtCaseId,
    automationId,
  });
  return createCollectionEvent({
    automationId: resolvedAutomationId,
    debtCaseId,
    channel: "call",
    eventType,
    payload,
  });
};

const AGREEMENT_ALLOWED_FSM_STATES = new Set([
  CALL_STATES.CONFIRM_AGREEMENT,
  CALL_STATES.EXECUTE_AGREEMENT,
]);

const DISPUTE_ALLOWED_FSM_STATES = new Set([
  CALL_STATES.DISPUTE_CAPTURE,
  CALL_STATES.EXECUTE_DISPUTE,
]);

const CALL_STALE_TTL_SECONDS =
  Number(process.env.CALL_STALE_TTL_SECONDS) || 1800;

const isStaleActiveCallInteraction = (interaction) => {
  if (!interaction) return false;
  if (
    !["queued", "in_progress"].includes(
      String(interaction.status || "").toLowerCase(),
    )
  ) {
    return false;
  }

  const referenceDate =
    interaction.updatedAt || interaction.startedAt || interaction.createdAt;
  const referenceMs = referenceDate ? new Date(referenceDate).getTime() : NaN;
  if (!Number.isFinite(referenceMs)) return false;
  return Date.now() - referenceMs > CALL_STALE_TTL_SECONDS * 1000;
};

const closeStaleCallInteraction = async (
  interaction,
  reason = "stale_call_interaction",
) => {
  if (!interaction || !isStaleActiveCallInteraction(interaction))
    return interaction;

  await interaction.update({
    status: "failed",
    outcome: "FAILED",
    endedAt: interaction.endedAt || new Date(),
    error: {
      ...(interaction.error || {}),
      message: reason,
    },
    aiData: {
      ...(interaction.aiData || {}),
      eleven: {
        ...(interaction.aiData?.eleven || {}),
        call_state: {
          ...(interaction.aiData?.eleven?.call_state || {}),
          previous_state:
            interaction.aiData?.eleven?.call_state?.state ||
            CALL_STATES.VERIFY_IDENTITY,
          state: CALL_STATES.CLOSE,
          last_action: CALL_ACTIONS.END_CALL,
          last_tool_code: reason,
          updated_at: new Date().toISOString(),
        },
      },
    },
  });

  logger.warn(
    {
      interactionId: interaction.id,
      debtCaseId: interaction.debtCaseId,
      status: interaction.status,
      reason,
      ttlSeconds: CALL_STALE_TTL_SECONDS,
    },
    "Auto-closed stale active call interaction",
  );

  return interaction;
};

/**
 * Closes stale queued/in_progress CALL rows for a debt case (TTL via CALL_STALE_TTL_SECONDS).
 * Call before enqueueing a new call so old stuck rows do not block workers/UI.
 */
export const expireStaleCallInteractionsForDebtCase = async (
  tenantId,
  debtCaseId,
) => {
  const rows = await InteractionLog.findAll({
    where: {
      tenantId,
      debtCaseId,
      type: "CALL",
      status: { [Op.in]: ["queued", "in_progress"] },
    },
    include: [{ model: DebtCase, as: "debtCase" }],
    order: [["createdAt", "DESC"]],
    limit: 25,
  });
  for (const row of rows) {
    await closeStaleCallInteraction(row, "stale_before_new_call_attempt");
  }
};

const markInteractionFailedOnRegisterError = async (interaction, err) => {
  try {
    await interaction.reload();
  } catch (_e) {
    return;
  }
  const st = String(interaction.status || "").toLowerCase();
  // Only fix rows still in "queued". If already "in_progress", Twilio may be retrying the webhook;
  // do not clobber a successful first leg.
  if (st !== "queued") return;
  const message = err?.message || String(err);
  await interaction.update({
    status: "failed",
    outcome: "FAILED",
    endedAt: new Date(),
    error: {
      message,
      phase: "register_call_for_interaction",
    },
  });
  logger.warn(
    {
      interactionId: interaction.id,
      debtCaseId: interaction.debtCaseId,
      message,
    },
    "Marked interaction failed after register-call error",
  );
};

const resolveToolInteractionContext = async ({
  tenantId,
  caseId,
  interactionId,
}) => {
  const byId = normalizeUuid(interactionId);
  if (byId) {
    const interaction = await InteractionLog.findOne({
      where: {
        id: byId,
        tenantId,
        debtCaseId: caseId,
        type: "CALL",
      },
      include: [{ model: DebtCase, as: "debtCase" }],
    });
    return closeStaleCallInteraction(
      interaction,
      "stale_call_interaction_by_id",
    );
  }

  const latestInteraction = await InteractionLog.findOne({
    where: {
      tenantId,
      debtCaseId: caseId,
      type: "CALL",
      status: { [Op.in]: ["queued", "in_progress", "completed"] },
    },
    include: [{ model: DebtCase, as: "debtCase" }],
    order: [["updatedAt", "DESC"]],
  });
  return closeStaleCallInteraction(
    latestInteraction,
    "stale_call_interaction_latest",
  );
};

const resolveCallStateFromInteraction = (interaction) =>
  normalizeCallState(interaction?.aiData?.eleven?.call_state?.state) ||
  CALL_STATES.VERIFY_IDENTITY;

const normalizePlainObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const hasMeaningfulProposal = (value) => {
  const source = normalizePlainObject(value);
  return Object.values(source).some(
    (item) => item !== undefined && item !== null && item !== "",
  );
};

const normalizePositiveInteger = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.trunc(numeric);
  return rounded > 0 ? rounded : null;
};

const normalizeAgreementProposalInput = (value) => {
  const source = normalizePlainObject(value);
  const planType = normalizePlanCode(
    source.plan_type || source.planType || source.plan_code || source.planCode,
  );
  const upfrontAmount =
    source.upfront_amount_cents ??
    source.upfrontAmountCents ??
    source.upfront_amount ??
    source.upfrontAmount ??
    null;
  const installmentsCount = normalizePositiveInteger(
    source.installments_count ?? source.installmentsCount ?? null,
  );
  const deliveryChannel = String(
    source.delivery_channel ||
      source.deliveryChannel ||
      source.preferred_delivery_channel ||
      source.preferredDeliveryChannel ||
      source.channel ||
      "",
  )
    .trim()
    .toLowerCase();
  const deliveryEmail = String(
    source.delivery_email ||
      source.deliveryEmail ||
      source.email ||
      source.recipient_email ||
      source.recipientEmail ||
      "",
  ).trim();
  const firstDueDate = source.first_due_date || source.firstDueDate || null;

  return {
    ...source,
    ...(planType ? { plan_type: planType } : {}),
    ...(upfrontAmount !== null && upfrontAmount !== undefined
      ? { upfront_amount_cents: upfrontAmount }
      : {}),
    ...(installmentsCount ? { installments_count: installmentsCount } : {}),
    ...(firstDueDate ? { first_due_date: firstDueDate } : {}),
    ...(deliveryChannel ? { delivery_channel: deliveryChannel } : {}),
    ...(deliveryEmail ? { delivery_email: deliveryEmail } : {}),
  };
};

const normalizeDisputeProposalInput = (value) => {
  const source = normalizePlainObject(value);
  const reason = normalizeDisputeReason(
    source.reason || source.dispute_reason || source.disputeReason || null,
  );
  const deliveryChannel = String(
    source.delivery_channel ||
      source.deliveryChannel ||
      source.preferred_delivery_channel ||
      source.preferredDeliveryChannel ||
      source.channel ||
      "",
  )
    .trim()
    .toLowerCase();
  const deliveryEmail = String(
    source.delivery_email ||
      source.deliveryEmail ||
      source.email ||
      source.recipient_email ||
      source.recipientEmail ||
      "",
  ).trim();

  const evidenceUrlsRaw =
    source.evidence_urls || source.evidenceUrls || source.evidence_url || [];
  const evidenceUrls = (
    Array.isArray(evidenceUrlsRaw) ? evidenceUrlsRaw : [evidenceUrlsRaw]
  )
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 10);

  return {
    ...source,
    ...(reason ? { reason } : {}),
    ...(deliveryChannel ? { delivery_channel: deliveryChannel } : {}),
    ...(deliveryEmail ? { delivery_email: deliveryEmail } : {}),
    ...(evidenceUrls.length > 0 ? { evidence_urls: evidenceUrls } : {}),
  };
};

const resolveAgreementProposalForExecution = ({ interaction, proposal }) => {
  const callState = normalizePlainObject(
    interaction?.aiData?.eleven?.call_state,
  );
  const committedEnvelope = normalizePlainObject(callState.proposal_committed);
  const snapshotEnvelope = normalizePlainObject(callState.proposal_snapshot);
  const draftsEnvelope = normalizePlainObject(callState.proposal_drafts);

  const committed = normalizePlainObject(committedEnvelope.agreement);
  const snapshot = normalizePlainObject(snapshotEnvelope.agreement);
  const draft = normalizePlainObject(draftsEnvelope.agreement);
  const payload = normalizePlainObject(proposal);

  if (hasMeaningfulProposal(committed)) {
    return {
      proposal: normalizeAgreementProposalInput(committed),
      source: "committed_snapshot",
      snapshot_version:
        Number(snapshotEnvelope.version || committedEnvelope.version || 0) ||
        null,
      committed_version: Number(committedEnvelope.version || 0) || null,
    };
  }

  if (hasMeaningfulProposal(snapshot)) {
    return {
      proposal: normalizeAgreementProposalInput(snapshot),
      source: "proposal_snapshot",
      snapshot_version: Number(snapshotEnvelope.version || 0) || null,
      committed_version: Number(committedEnvelope.version || 0) || null,
    };
  }

  if (hasMeaningfulProposal(draft)) {
    return {
      proposal: normalizeAgreementProposalInput(draft),
      source: "proposal_draft",
      snapshot_version: Number(snapshotEnvelope.version || 0) || null,
      committed_version: Number(committedEnvelope.version || 0) || null,
    };
  }

  return {
    proposal: normalizeAgreementProposalInput(payload),
    source: "payload",
    snapshot_version: Number(snapshotEnvelope.version || 0) || null,
    committed_version: Number(committedEnvelope.version || 0) || null,
  };
};

const resolveDisputeProposalForExecution = ({ interaction, proposal }) => {
  const callState = normalizePlainObject(
    interaction?.aiData?.eleven?.call_state,
  );
  const committedEnvelope = normalizePlainObject(callState.proposal_committed);
  const snapshotEnvelope = normalizePlainObject(callState.proposal_snapshot);
  const draftsEnvelope = normalizePlainObject(callState.proposal_drafts);

  const committed = normalizePlainObject(committedEnvelope.dispute);
  const snapshot = normalizePlainObject(snapshotEnvelope.dispute);
  const draft = normalizePlainObject(draftsEnvelope.dispute);
  const payload = normalizePlainObject(proposal);

  if (hasMeaningfulProposal(committed)) {
    return {
      proposal: normalizeDisputeProposalInput(committed),
      source: "committed_snapshot",
      snapshot_version:
        Number(snapshotEnvelope.version || committedEnvelope.version || 0) ||
        null,
      committed_version: Number(committedEnvelope.version || 0) || null,
    };
  }

  if (hasMeaningfulProposal(snapshot)) {
    return {
      proposal: normalizeDisputeProposalInput(snapshot),
      source: "proposal_snapshot",
      snapshot_version: Number(snapshotEnvelope.version || 0) || null,
      committed_version: Number(committedEnvelope.version || 0) || null,
    };
  }

  if (hasMeaningfulProposal(draft)) {
    return {
      proposal: normalizeDisputeProposalInput(draft),
      source: "proposal_draft",
      snapshot_version: Number(snapshotEnvelope.version || 0) || null,
      committed_version: Number(committedEnvelope.version || 0) || null,
    };
  }

  return {
    proposal: normalizeDisputeProposalInput(payload),
    source: "payload",
    snapshot_version: Number(snapshotEnvelope.version || 0) || null,
    committed_version: Number(committedEnvelope.version || 0) || null,
  };
};

const updateInteractionCallStateFromTool = async ({
  interaction,
  nextState,
  action,
  tool,
  toolOk,
  toolCode,
  facts,
  closingContext,
}) => {
  if (!interaction) return;

  const previousStateSnapshot = interaction.aiData?.eleven?.call_state || {};
  const previousFacts =
    previousStateSnapshot?.facts &&
    typeof previousStateSnapshot.facts === "object" &&
    !Array.isArray(previousStateSnapshot.facts)
      ? previousStateSnapshot.facts
      : {};
  const previousState =
    normalizeCallState(previousStateSnapshot.state) ||
    CALL_STATES.VERIFY_IDENTITY;
  const targetState = normalizeCallState(nextState) || previousState;
  const safeAction =
    String(action || "").trim() || previousStateSnapshot.last_action || null;
  const safeTool =
    String(tool || "").trim() || previousStateSnapshot.last_tool || null;
  const hasToolOk = typeof toolOk === "boolean";
  const hasToolCode =
    toolCode !== undefined &&
    toolCode !== null &&
    String(toolCode).trim() !== "";
  const nextFacts =
    facts && typeof facts === "object" && !Array.isArray(facts)
      ? { ...previousFacts, ...facts }
      : { ...previousFacts };

  if (String(closingContext || "").trim()) {
    nextFacts.closing_context = String(closingContext).trim();
  }

  await interaction.update({
    aiData: {
      ...(interaction.aiData || {}),
      eleven: {
        ...(interaction.aiData?.eleven || {}),
        call_state: {
          ...previousStateSnapshot,
          previous_state: previousState,
          state: targetState,
          last_action: safeAction,
          last_tool: safeTool,
          last_tool_ok: hasToolOk
            ? toolOk
            : (previousStateSnapshot.last_tool_ok ?? null),
          last_tool_code: hasToolCode
            ? String(toolCode)
            : previousStateSnapshot.last_tool_code || null,
          facts: nextFacts,
          updated_at: new Date().toISOString(),
        },
      },
    },
  });
};

const resolveCaseStatusFromAgreementType = (agreementType) =>
  agreementType === "INSTALLMENTS" ? "PAYMENT_PLAN" : "PROMISE_TO_PAY";

const findExistingAgreementByInteraction = async ({
  tenantId,
  debtCaseId,
  interactionId,
}) => {
  const safeInteractionId = normalizeUuid(interactionId);
  if (!safeInteractionId) return null;

  return PaymentAgreement.findOne({
    where: {
      tenantId,
      debtCaseId,
      createdBy: "AI",
      status: { [Op.in]: ["PENDING", "ACTIVE", "ACCEPTED"] },
      terms: {
        [Op.contains]: {
          interaction_id: safeInteractionId,
        },
      },
    },
    order: [["createdAt", "DESC"]],
  });
};

export const getCallStateSnapshot = async ({
  tenantId,
  caseId,
  interactionId,
}) => {
  const interaction = await resolveToolInteractionContext({
    tenantId,
    caseId,
    interactionId,
  });

  if (!interaction) {
    return {
      ok: false,
      code: "INTERACTION_NOT_FOUND",
      message: "No call interaction found for this context.",
    };
  }

  const callState = interaction.aiData?.eleven?.call_state || null;
  return {
    ok: true,
    interaction_id: interaction.id,
    debt_case_id: interaction.debtCaseId,
    tenant_id: interaction.tenantId,
    status: interaction.status,
    provider_ref: interaction.providerRef || null,
    current_state:
      normalizeCallState(callState?.state) || CALL_STATES.VERIFY_IDENTITY,
    previous_state: normalizeCallState(callState?.previous_state) || null,
    last_intent: callState?.last_intent || null,
    last_action: callState?.last_action || null,
    last_tool: callState?.last_tool || null,
    last_tool_ok:
      typeof callState?.last_tool_ok === "boolean"
        ? callState.last_tool_ok
        : null,
    last_tool_code: callState?.last_tool_code || null,
    updated_at: callState?.updated_at || null,
    slots:
      callState?.slots && typeof callState.slots === "object"
        ? callState.slots
        : null,
    nlu: callState?.nlu || null,
    proposal_drafts: callState?.proposal_drafts || null,
    proposal_snapshot: callState?.proposal_snapshot || null,
    proposal_committed: callState?.proposal_committed || null,
    facts:
      callState?.facts && typeof callState.facts === "object"
        ? callState.facts
        : null,
    state_stack: Array.isArray(callState?.state_stack)
      ? callState.state_stack
      : [],
    return_state: normalizeCallState(callState?.return_state) || null,
    interruption_topic:
      String(callState?.interruption_topic || "").trim() || null,
    telemetry: callState?.telemetry || null,
  };
};

const createLinkDeliveryInteractionLog = async ({
  tenantId,
  debtCaseId,
  debtorId,
  type,
  status,
  providerRef = null,
  summary = null,
  outcome = null,
  error = {},
  aiData = {},
}) =>
  InteractionLog.create({
    tenantId,
    debtCaseId,
    debtorId,
    type,
    direction: "OUTBOUND",
    channelProvider: type === "SMS" ? "twilio" : "ses",
    status,
    providerRef,
    summary,
    outcome,
    startedAt: new Date(),
    endedAt: new Date(),
    aiData,
    error,
  });

const buildAgreementSmsBody = ({
  debtorName,
  tenantName,
  paymentLinkUrl,
}) =>
  buildConciseLinkSmsBody({
    debtorName,
    tenantName,
    paymentLink: paymentLinkUrl,
    fallbackText: "Reply to continue. STOP=opt out.",
  });

const buildDisputeSmsBody = ({
  debtorName,
  tenantName,
  paymentLinkUrl,
}) =>
  buildConciseLinkSmsBody({
    debtorName,
    tenantName,
    paymentLink: paymentLinkUrl,
    linkLabel: "Dispute link:",
    fallbackText: "Reply for support. STOP=opt out.",
  });

const sendCaseLinkSms = async ({
  tenantId,
  debtCaseId,
  debtor,
  paymentLinkUrl,
  tenantName,
  automationId,
  context = "agreement",
  agreementId = null,
  disputeId = null,
}) => {
  const entityKey = context === "dispute" ? "dispute_id" : "agreement_id";
  const entityValue = context === "dispute" ? disputeId : agreementId;
  const summaryBodyBuilder =
    context === "dispute" ? buildDisputeSmsBody : buildAgreementSmsBody;
  const successEventType =
    context === "dispute" ? "dispute_link_sent" : "payment_link_sent";
  const failedEventType =
    context === "dispute" ? "dispute_link_failed" : "payment_link_failed";

  const to = String(debtor?.phone || "").trim();
  if (!to) {
    await createCollectionEvent({
      automationId,
      debtCaseId,
      channel: "sms",
      eventType: failedEventType,
      payload: {
        reason: "missing_phone",
        [entityKey]: entityValue,
      },
    });
    return { ok: false, channel: "sms", reason: "missing_phone" };
  }

  const body = summaryBodyBuilder({
    debtorName: debtor.fullName || "there",
    tenantName,
    paymentLinkUrl,
  });

  try {
    const provider = await sendTwilioSms({ to, body });
    const log = await createLinkDeliveryInteractionLog({
      tenantId,
      debtCaseId,
      debtorId: debtor.id,
      type: "SMS",
      status: "sent",
      providerRef: provider.messageSid,
      summary: body.slice(0, 500),
      aiData: {
        payment_link_url: paymentLinkUrl,
        [entityKey]: entityValue,
        context: `${context}_link_delivery`,
        delivery_profile: "concise_link",
        payment_link_attribution: "disabled_for_sms",
      },
    });

    await createCollectionEvent({
      automationId,
      debtCaseId,
      channel: "sms",
      eventType: successEventType,
      payload: {
        interactionLogId: log.id,
        [entityKey]: entityValue,
        to,
        providerRef: provider.messageSid,
      },
    });

    return {
      ok: true,
      channel: "sms",
      interactionLogId: log.id,
      providerRef: provider.messageSid,
    };
  } catch (error) {
    const message = error?.message || "SMS payment link delivery failed";
    await createLinkDeliveryInteractionLog({
      tenantId,
      debtCaseId,
      debtorId: debtor.id,
      type: "SMS",
      status: "failed",
      outcome: "FAILED",
      summary: "Payment link delivery failed by SMS.",
      error: { message },
      aiData: {
        payment_link_url: paymentLinkUrl,
        [entityKey]: entityValue,
        context: `${context}_link_delivery`,
        delivery_profile: "concise_link",
        payment_link_attribution: "disabled_for_sms",
      },
    });
    await createCollectionEvent({
      automationId,
      debtCaseId,
      channel: "sms",
      eventType: failedEventType,
      payload: {
        [entityKey]: entityValue,
        reason: message,
      },
    });
    return { ok: false, channel: "sms", reason: message };
  }
};

const sendCaseLinkEmail = async ({
  tenantId,
  debtCaseId,
  debtor,
  deliveryEmail,
  deliveryEmailRaw = null,
  paymentLinkUrl,
  tenantName,
  automationId,
  context = "agreement",
  agreementId = null,
  disputeId = null,
}) => {
  const entityKey = context === "dispute" ? "dispute_id" : "agreement_id";
  const entityValue = context === "dispute" ? disputeId : agreementId;
  const successEventType =
    context === "dispute" ? "dispute_link_sent" : "payment_link_sent";
  const failedEventType =
    context === "dispute" ? "dispute_link_failed" : "payment_link_failed";

  const hasRawDeliveryEmail =
    typeof deliveryEmailRaw === "string" && deliveryEmailRaw.trim().length > 0;
  const toFromDelivery = normalizeEmailCandidate(deliveryEmail);
  const toFromDebtor = hasRawDeliveryEmail
    ? null
    : normalizeEmailCandidate(debtor?.email);
  const to = toFromDelivery || toFromDebtor;

  if (!to) {
    await createCollectionEvent({
      automationId,
      debtCaseId,
      channel: "email",
      eventType: failedEventType,
      payload: {
        reason: hasRawDeliveryEmail
          ? "invalid_delivery_email"
          : "missing_email",
        [entityKey]: entityValue,
      },
    });
    return {
      ok: false,
      channel: "email",
      reason: hasRawDeliveryEmail ? "invalid_delivery_email" : "missing_email",
    };
  }

  const rendered = renderElevenLinkEmail({
    context: context === "dispute" ? "dispute" : "agreement",
    debtorName: debtor.fullName || "there",
    tenantName,
    paymentLinkUrl,
  });
  const subject = rendered.subject;
  const text = rendered.text;
  const html = rendered.html;

  try {
    const sesTags = [
      { name: "tenant_id", value: String(tenantId) },
      { name: "debt_case_id", value: String(debtCaseId) },
      { name: "channel", value: "email" },
    ];
    if (entityValue) {
      sesTags.push({ name: entityKey, value: String(entityValue) });
    }

    const provider = await sendSesEmail({
      to,
      subject,
      text,
      html,
      tags: sesTags,
    });

    const log = await createLinkDeliveryInteractionLog({
      tenantId,
      debtCaseId,
      debtorId: debtor.id,
      type: "EMAIL",
      status: "sent",
      providerRef: provider.messageId,
      summary: text.slice(0, 500),
      aiData: {
        payment_link_url: paymentLinkUrl,
        [entityKey]: entityValue,
        context: `${context}_link_delivery`,
      },
    });

    await createCollectionEvent({
      automationId,
      debtCaseId,
      channel: "email",
      eventType: successEventType,
      payload: {
        interactionLogId: log.id,
        [entityKey]: entityValue,
        to,
        providerRef: provider.messageId,
      },
    });

    return {
      ok: true,
      channel: "email",
      interactionLogId: log.id,
      providerRef: provider.messageId,
    };
  } catch (error) {
    const message = error?.message || "Email payment link delivery failed";
    await createLinkDeliveryInteractionLog({
      tenantId,
      debtCaseId,
      debtorId: debtor.id,
      type: "EMAIL",
      status: "failed",
      outcome: "FAILED",
      summary: "Payment link delivery failed by email.",
      error: { message },
      aiData: {
        payment_link_url: paymentLinkUrl,
        [entityKey]: entityValue,
        context: `${context}_link_delivery`,
      },
    });
    await createCollectionEvent({
      automationId,
      debtCaseId,
      channel: "email",
      eventType: failedEventType,
      payload: {
        [entityKey]: entityValue,
        reason: message,
      },
    });
    return { ok: false, channel: "email", reason: message };
  }
};

const resolveCaseStatusFromOutcome = (currentStatus, outcome) => {
  if (!outcome) return null;

  // Keep payment statuses when already negotiated.
  if (["PAYMENT_PLAN", "PROMISE_TO_PAY", "PAID"].includes(currentStatus)) {
    return null;
  }

  switch (outcome) {
    case "PAID":
      return "PAID";
    case "PAYMENT_PLAN":
      return "PAYMENT_PLAN";
    case "PROMISE_TO_PAY":
      return "PROMISE_TO_PAY";
    case "REFUSED":
      return "REFUSED";
    case "NO_ANSWER":
    case "VOICEMAIL":
      return "NO_ANSWER";
    case "CONNECTED":
      return "CONTACTED";
    default:
      return null;
  }
};

export const resolveInteractionContext = async (interactionId) =>
  InteractionLog.findOne({
    where: { id: interactionId },
    include: [
      {
        model: DebtCase,
        as: "debtCase",
        include: [
          { model: Debtor, as: "debtor" },
          { model: FlowPolicy, as: "flowPolicy" },
        ],
      },
    ],
  });

export const registerCallForInteraction = async ({
  interactionId,
  twilioCallSid,
  twilioFrom,
  twilioTo,
  extraDynamicVariables = {},
}) => {
  const interaction = await resolveInteractionContext(interactionId);
  if (!interaction) {
    throw new Error(`Interaction log not found for id=${interactionId}`);
  }

  try {
    return await executeRegisterCallForInteraction({
      interaction,
      interactionId,
      twilioCallSid,
      twilioFrom,
      twilioTo,
      extraDynamicVariables,
    });
  } catch (err) {
    await markInteractionFailedOnRegisterError(interaction, err);
    throw err;
  }
};

const executeRegisterCallForInteraction = async ({
  interaction,
  interactionId,
  twilioCallSid,
  twilioFrom,
  twilioTo,
  extraDynamicVariables = {},
}) => {
  const debtCase = interaction.debtCase;
  const debtor = debtCase?.debtor;
  if (!debtCase || !debtor) {
    throw new Error(
      `Interaction ${interactionId} has no debt case/debtor context`,
    );
  }

  const demoSource = debtCase?.meta?.source === "demo-ui";
  const agentId =
    (demoSource ? process.env.ELEVENLABS_AGENT_ID_DEMO : null) ||
    process.env.ELEVENLABS_AGENT_ID;
  if (!agentId) {
    throw new Error("Missing ELEVENLABS_AGENT_ID env var");
  }

  const resolvedPolicy = await resolvePolicyForCase(
    interaction.tenantId,
    debtCase,
  );
  const flowRules = getRulesFromResolvedPolicy(resolvedPolicy);
  const allowedPlanCodes = normalizePlanCodes(
    resolvedPolicy?.rules?.allowed_plans,
  );
  const allowedPaymentChannelCodes = normalizeChannelCodes(
    resolvedPolicy?.rules?.payment_channels,
  );
  const tenant = await Tenant.findByPk(interaction.tenantId, {
    attributes: ["id", "name"],
  });

  const paymentInstructions = await buildPaymentInstructions({
    tenantId: interaction.tenantId,
    debtCaseId: debtCase.id,
    casePublicId: debtCase.casePublicId ?? debtCase.case_public_id ?? "",
    debtorId: debtor.id,
    pmsLeaseId: debtCase.pmsLeaseId ?? debtCase.pms_lease_id ?? null,
  });

  const filteredPaymentInstructions =
    allowedPaymentChannelCodes.length > 0
      ? paymentInstructions.filter((item) =>
          allowedPaymentChannelCodes.includes(
            String(item.code || "").toLowerCase(),
          ),
        )
      : paymentInstructions;

  const paymentInstructionsSummary = buildPaymentInstructionSummary(
    filteredPaymentInstructions,
  );

  /** Shorter prompts + smaller JSON payload → faster time-to-options in ConvAI (opt-in). */
  const convaiBrevityMode =
    process.env.ELEVEN_CONVAI_BREVITY_MODE === "true" ||
    process.env.ELEVEN_CONVAI_BREVITY_MODE === "1";

  const paymentJsonMaxChars = convaiBrevityMode ? 1500 : 4000;
  const paymentInstructionsJson = truncateString(
    JSON.stringify(filteredPaymentInstructions),
    paymentJsonMaxChars,
  );

  const customInstructions = resolvedPolicy?.rules?.custom_instructions ?? "";
  const openingMessageFromRules = resolvedPolicy?.rules?.opening_message ?? "";
  const tenantDisplayNameFromRules =
    resolvedPolicy?.rules?.tenant_display_name ?? "";
  const metaForVariables = {
    ...(debtCase.meta || {}),
    channels:
      debtCase.meta?.channels ?? resolvedPolicy?.rules?.payment_channels,
  };
  const openingMessage = String(
    metaForVariables.opening_message || openingMessageFromRules || "",
  )
    .trim()
    .slice(0, 2000);
  const tenantDisplayName = String(
    metaForVariables.tenant_name ||
      metaForVariables.tenant_display_name ||
      tenantDisplayNameFromRules ||
      tenant?.name ||
      "",
  )
    .trim()
    .slice(0, 200);
  if (!tenantDisplayName) {
    throw new Error(
      "Missing tenant display name for ElevenLabs context (tenant_name is required).",
    );
  }

  const complianceInstructions = [
    "Before disclosing any balance or payment details, verify you are speaking with the intended debtor.",
    `Ask: "Am I speaking with ${debtor.fullName}?"`,
    "If identity is not confirmed, do not disclose debt information and politely end the call or request callback with the debtor.",
  ].join(" ");

  const brevityPacing = convaiBrevityMode
    ? [
        "Dialog pacing (high priority): Use short turns (about 2–3 sentences) until the debtor picks a plan.",
        "After identity is confirmed: give one brief compliance line if your policy requires it, then state the balance in one sentence.",
        "Immediately list the allowed options using allowed_plans_human (short labels only) and ask which they prefer.",
        "Do not read payment_channels_context_json aloud; use payment_channels_context as reference only.",
        "If the user is already responding, acknowledge briefly and continue—avoid repeating the full script.",
      ].join(" ")
    : "";

  /** Default on: long silences hurt outbound collections UX. Disable with ELEVEN_CONVAI_REDUCE_DEAD_AIR=false */
  const reduceDeadAir =
    process.env.ELEVEN_CONVAI_REDUCE_DEAD_AIR !== "false" &&
    process.env.ELEVEN_CONVAI_REDUCE_DEAD_AIR !== "0";

  const deadAirInstructions = reduceDeadAir
    ? [
        "Minimize dead air (critical on phone): Start your next utterance within about one second after the user stops speaking.",
        "If you need compute time before a longer reply, open the same turn with a sub-second acknowledgment (e.g. Okay, Got it, Thanks) then continue—do not leave the line quiet for several seconds.",
        "When listing payment options or next steps, deliver items back-to-back in short clauses; avoid long gaps between options.",
        "Prefer one short bridge word over silence; avoid long ums or repeating the same filler.",
      ].join(" ")
    : "";

  const fpWindow = computeFirstPaymentWindowFromPolicyRules(
    resolvedPolicy?.rules || {},
    NEGOTIATION_CALENDAR_TZ,
  );
  const monthEndWeekdayNote = fpWindow.lastWeekdayCapYmd
    ? ` The policy caps first payment at the last Monday–Friday of the current calendar month (${fpWindow.lastWeekdayCapYmd} in ${fpWindow.timeZone}; weekends excluded, public holidays not excluded). Do not accept or propose first_due_date after that day.`
    : "";
  const negotiationDateInstructions = [
    "Payment commitment date (required before create-payment-agreement): Ask the debtor when they can pay the agreed amount (first payment or first installment).",
    "You must obtain an explicit calendar date from the debtor in the conversation (they must agree to that day out loud or clearly confirm it). Do not invent first_due_date, silently default to today, or use a date they have not confirmed.",
    `You must set first_due_date as YYYY-MM-DD in the tool payload. Earliest allowed date: ${fpWindow.minDate} (${fpWindow.timeZone} calendar).`,
    fpWindow.maxDate
      ? `Latest allowed first payment date: ${fpWindow.maxDate} (inclusive). Do not use a date after this.${monthEndWeekdayNote}`
      : `No latest deadline is configured in policy; any date on or after the earliest date is allowed.${monthEndWeekdayNote}`,
  ].join(" ");

  const customInstructionsMerged = [
    String(customInstructions || "").trim(),
    negotiationDateInstructions,
    brevityPacing,
    deadAirInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
  const customInstructionsMax =
    convaiBrevityMode || deadAirInstructions ? 3000 : 2200;

  const fallbackOpeningMessage = `Hi, this is Ivanna from ${tenantDisplayName}. For privacy, I can only discuss account details with the account holder. Am I speaking with ${debtor.fullName}?`;
  const resolvedOpeningMessage = openingMessage || fallbackOpeningMessage;

  const allowedPlanSelection = normalizeSelectionValues(
    allowedPlanCodes,
    PAYMENT_OPTION_LABELS,
  );
  const allowedChannelSelection = normalizeSelectionValues(
    allowedPaymentChannelCodes,
    PAYMENT_CHANNEL_LABELS,
  );

  const agreementContextVars = await buildAgreementContextDynamicVariables({
    tenantId: interaction.tenantId,
    debtCaseId: debtCase.id,
  });

  const dynamicVariables = {
    tenant_id: String(interaction.tenantId),
    case_id: String(debtCase.id),
    debtor_id: String(debtor.id),
    interaction_id: String(interaction.id),
    customer_name: debtor.fullName,
    debtor_email: String(debtor.email || "").trim(),
    balance_amount_cents: String(debtCase.amountDueCents),
    balance_amount: centsToDisplayAmount(debtCase.amountDueCents),
    currency: debtCase.currency || "USD",
    call_sid: twilioCallSid || "",
    stage_name: resolvedPolicy?.stage?.name || "",
    stage_tone:
      resolvedPolicy?.stage?.tone || resolvedPolicy?.tone || "professional",
    stage_min_days_past_due:
      resolvedPolicy?.stage?.minDaysPastDue != null
        ? String(resolvedPolicy.stage.minDaysPastDue)
        : "",
    stage_max_days_past_due:
      resolvedPolicy?.stage?.maxDaysPastDue != null
        ? String(resolvedPolicy.stage.maxDaysPastDue)
        : "",
    allowed_plans:
      allowedPlanSelection.ids || String(flowRules.allowedPlanTypes.join(",")),
    allowed_plans_human: allowedPlanSelection.human,
    allowed_payment_channels:
      allowedChannelSelection.ids ||
      String(allowedPaymentChannelCodes.join(",")),
    allowed_payment_channels_human: allowedChannelSelection.human,
    payment_channels_context: paymentInstructionsSummary,
    payment_channels_context_json: paymentInstructionsJson,
    max_installments: String(flowRules.maxInstallments),
    min_upfront_pct: String(flowRules.minUpfrontPct),
    half_pct: String(flowRules.halfPct),
    first_payment_earliest_date: fpWindow.minDate,
    first_payment_latest_date: fpWindow.maxDate || "",
    first_payment_last_weekday_of_month_cap:
      fpWindow.lastWeekdayCapYmd || "",
    first_payment_calendar_tz: fpWindow.timeZone,
    custom_instructions: customInstructionsMerged.slice(0, customInstructionsMax),
    compliance_instructions: complianceInstructions,
    identity_verification_required: "true",
    opening_message: resolvedOpeningMessage,
    initial_message: resolvedOpeningMessage,
    tenant_name: tenantDisplayName,
    tenant_display_name: tenantDisplayName,
    ...buildCaseMetadataDynamicVariables(metaForVariables),
    ...agreementContextVars,
    ...extraDynamicVariables,
  };

  const payload = {
    agent_id: agentId,
    from_number: twilioFrom || process.env.TWILIO_FROM_NUMBER || "",
    to_number: twilioTo || debtor.phone || "",
    direction: "outbound",
    conversation_initiation_client_data: {
      user_id: twilioTo || debtor.phone || "",
      source_info: {
        source: process.env.ELEVENLABS_SOURCE || "twilio",
        version: "v1",
      },
      dynamic_variables: dynamicVariables,
      // VAD overrides — reduce noise-triggered interruptions on phone calls.
      // Tune via env vars without redeploying. Defaults are conservative for outbound collections.
      agent_config: {
        conversation: {
          config: {
            turn_detection: {
              threshold: Number(process.env.ELEVEN_VAD_THRESHOLD) || 0.55,
              prefix_padding_ms: Number(process.env.ELEVEN_VAD_PREFIX_PADDING_MS) || 400,
              silence_duration_ms: Number(process.env.ELEVEN_VAD_SILENCE_DURATION_MS) || 700,
            },
          },
        },
      },
    },
  };

  if (!payload.from_number || !payload.to_number) {
    throw new Error(
      "Missing from_number/to_number required by ElevenLabs register-call",
    );
  }

  const twiml = await registerTwilioCallInElevenLabs(payload);

  await interaction.update({
    status: "in_progress",
    startedAt: interaction.startedAt || new Date(),
    channelProvider: "ELEVENLABS_TWILIO",
    providerRef: twilioCallSid || interaction.providerRef || null,
    aiData: {
      ...(interaction.aiData || {}),
      eleven_register_payload: payload,
      eleven: {
        ...(interaction.aiData?.eleven || {}),
        call_state: {
          state:
            interaction.aiData?.eleven?.call_state?.state ||
            CALL_STATES.VERIFY_IDENTITY,
          previous_state: interaction.aiData?.eleven?.call_state?.state || null,
          updated_at: new Date().toISOString(),
        },
      },
    },
  });

  return { twiml, interaction, payload };
};

export const syncInteractionFromPostCall = async ({
  normalizedPayload,
  s3Key,
}) => {
  const interactionId = normalizedPayload.interactionId;
  let interaction = null;

  if (interactionId) {
    interaction = await InteractionLog.findOne({
      where: { id: interactionId },
      include: [{ model: DebtCase, as: "debtCase" }],
    });
  }

  if (!interaction && normalizedPayload.conversationId) {
    interaction = await InteractionLog.findOne({
      where: { providerRef: normalizedPayload.conversationId },
      include: [{ model: DebtCase, as: "debtCase" }],
      order: [["updatedAt", "DESC"]],
    });
  }

  if (!interaction) {
    logger.warn(
      { interactionId, conversationId: normalizedPayload.conversationId },
      "Could not match ElevenLabs post-call payload to interaction log",
    );
    return null;
  }

  const interactionOutcome = SUPPORTED_INTERACTION_OUTCOMES.has(
    normalizedPayload.outcome,
  )
    ? normalizedPayload.outcome
    : null;

  await interaction.update({
    status: "completed",
    channelProvider: "ELEVENLABS_TWILIO",
    providerRef: normalizedPayload.conversationId || interaction.providerRef,
    outcome: interactionOutcome || interaction.outcome,
    startedAt: normalizedPayload.startedAt || interaction.startedAt,
    endedAt: normalizedPayload.endedAt || new Date(),
    transcript: JSON.stringify(normalizedPayload.transcript || []),
    summary: normalizedPayload.summary || interaction.summary,
    aiData: {
      ...(interaction.aiData || {}),
      eleven: {
        ...(interaction.aiData?.eleven || {}),
        conversation_id: normalizedPayload.conversationId,
        call_sid: normalizedPayload.callSid,
        dynamic_variables: normalizedPayload.dynamicVariables,
        metadata: normalizedPayload.raw?.data?.metadata || null,
        analysis: normalizedPayload.raw?.data?.analysis || null,
        s3_key: s3Key || null,
        call_state: {
          ...(interaction.aiData?.eleven?.call_state || {}),
          state: CALL_STATES.CLOSE,
          previous_state: interaction.aiData?.eleven?.call_state?.state || null,
          updated_at: new Date().toISOString(),
        },
      },
    },
  });

  if (interaction.debtCase) {
    const nextCaseStatus = resolveCaseStatusFromOutcome(
      interaction.debtCase.status,
      interactionOutcome,
    );

    await interaction.debtCase.update({
      ...(nextCaseStatus ? { status: nextCaseStatus } : {}),
      lastContactedAt: normalizedPayload.endedAt || new Date(),
      ...(interactionOutcome === "CALLBACK_REQUESTED"
        ? {
            nextActionAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            meta: {
              ...(interaction.debtCase.meta || {}),
              callback_requested: true,
            },
          }
        : {}),
    });
  }

  return interaction;
};

export const createPaymentAgreementFromTool = async ({
  tenantId,
  caseId,
  interactionId,
  conversationId,
  automationId,
  proposal,
}) => {
  const debtCase = await DebtCase.findOne({
    where: { id: caseId, tenantId },
    include: [{ model: Debtor, as: "debtor" }],
  });

  if (!debtCase) {
    return {
      ok: false,
      code: "CASE_NOT_FOUND",
      message: "Debt case not found for the provided tenant_id and case_id.",
    };
  }

  const interaction = await resolveToolInteractionContext({
    tenantId,
    caseId: debtCase.id,
    interactionId,
  });
  if (!interaction) {
    return {
      ok: false,
      code: "INTERACTION_NOT_FOUND",
      message: "Call interaction was not found for the provided context.",
    };
  }

  const currentState = resolveCallStateFromInteraction(interaction);
  if (!AGREEMENT_ALLOWED_FSM_STATES.has(currentState)) {
    const expectedStates = Array.from(AGREEMENT_ALLOWED_FSM_STATES);
    await updateInteractionCallStateFromTool({
      interaction,
      nextState: currentState,
      action: CALL_ACTIONS.NONE,
      tool: "create-payment-agreement",
      toolOk: false,
      toolCode: "INVALID_STATE_FOR_TOOL",
    });
    await createCallToolEvent({
      debtCaseId: debtCase.id,
      automationId,
      eventType: "agreement_tool_rejected_invalid_state",
      payload: {
        interaction_id: interaction.id,
        current_state: currentState,
        expected_states: expectedStates,
      },
    });
    return {
      ok: false,
      code: "INVALID_STATE_FOR_TOOL",
      message: `create-payment-agreement is only allowed in states: ${expectedStates.join(", ")}`,
      current_state: currentState,
      expected_states: expectedStates,
    };
  }

  const proposalResolution = resolveAgreementProposalForExecution({
    interaction,
    proposal,
  });
  const effectiveProposal = proposalResolution.proposal;

  const existingAgreement = await findExistingAgreementByInteraction({
    tenantId,
    debtCaseId: debtCase.id,
    interactionId,
  });
  if (existingAgreement) {
    const paymentLinkUrl =
      existingAgreement.paymentLinkUrl ||
      (await createPaymentLinkAndGetUrl({
        tenantId,
        debtCaseId: debtCase.id,
        paymentAgreementId: existingAgreement.id,
      }));

    if (!existingAgreement.paymentLinkUrl) {
      await existingAgreement.update({ paymentLinkUrl });
    }

    const caseStatus = resolveCaseStatusFromAgreementType(
      existingAgreement.type,
    );
    const requestedChannel = resolvePreferredDeliveryChannel(effectiveProposal);
    const requestedDeliveryEmail = normalizeEmailCandidate(
      effectiveProposal?.delivery_email ||
        effectiveProposal?.deliveryEmail ||
        effectiveProposal?.email ||
        effectiveProposal?.recipient_email ||
        effectiveProposal?.recipientEmail ||
        debtCase.debtor?.email ||
        "",
    );

    await updateInteractionCallStateFromTool({
      interaction,
      nextState: CALL_STATES.POST_DELIVERY_CONFIRM,
      action: CALL_ACTIONS.CALL_CREATE_PAYMENT_AGREEMENT,
      tool: "create-payment-agreement",
      toolOk: true,
      toolCode: "IDEMPOTENT_HIT",
      closingContext: "agreement_created",
      facts: {
        last_delivery_result: {
          requested_channel: requestedChannel,
          attempted_channels: [],
          successful_channels: [],
          failed_channels: [],
          email: requestedDeliveryEmail || null,
        },
        last_committed_plan: {
          plan_type:
            effectiveProposal?.plan_type ||
            effectiveProposal?.planType ||
            null,
          upfront_amount_cents:
            effectiveProposal?.upfront_amount_cents ||
            effectiveProposal?.upfrontAmountCents ||
            null,
          installments_count:
            effectiveProposal?.installments_count ||
            effectiveProposal?.installmentsCount ||
            null,
          delivery_channel: requestedChannel,
          first_due_date:
            effectiveProposal?.first_due_date ||
            effectiveProposal?.firstDueDate ||
            null,
        },
      },
    });
    await createCallToolEvent({
      debtCaseId: debtCase.id,
      automationId,
      eventType: "agreement_tool_idempotent",
      payload: {
        interaction_id: interaction.id,
        agreement_id: existingAgreement.id,
      },
    });

    return {
      ok: true,
      idempotent: true,
      agreement_id: existingAgreement.id,
      payment_link_url: paymentLinkUrl,
      proposal_source: proposalResolution.source,
      proposal_snapshot_version: proposalResolution.snapshot_version,
      proposal_committed_version: proposalResolution.committed_version,
      case_status: caseStatus,
      current_state: currentState,
      next_state: CALL_STATES.POST_DELIVERY_CONFIRM,
      speak_back:
        "Your payment agreement was already registered. Please use the secure link already sent.",
    };
  }

  const resolvedPolicy = await resolvePolicyForCase(tenantId, debtCase);
  const rules = getRulesFromResolvedPolicy(resolvedPolicy);
  const validation = validateProposalAgainstRules({
    proposal: effectiveProposal,
    balanceCents: Number(debtCase.amountDueCents),
    rules,
  });

  if (!validation.ok) {
    await updateInteractionCallStateFromTool({
      interaction,
      nextState: CALL_STATES.CONFIRM_AGREEMENT,
      action: CALL_ACTIONS.CALL_CREATE_PAYMENT_AGREEMENT,
      tool: "create-payment-agreement",
      toolOk: false,
      toolCode: validation.code || "VALIDATION_FAILED",
    });
    await createCallToolEvent({
      debtCaseId: debtCase.id,
      automationId,
      eventType: "agreement_tool_validation_failed",
      payload: {
        interaction_id: interaction.id,
        code: validation.code || "VALIDATION_FAILED",
        message: validation.message || null,
      },
    });
    return {
      ...validation,
      proposal_source: proposalResolution.source,
      proposal_snapshot_version: proposalResolution.snapshot_version,
      proposal_committed_version: proposalResolution.committed_version,
      current_state: currentState,
      next_state: CALL_STATES.CONFIRM_AGREEMENT,
      speak_back: buildAgreementValidationSpeakBack({
        validation,
        currency: debtCase.currency || "USD",
      }),
    };
  }

  const agreementType =
    validation.planConfig?.agreementType ||
    (isInstallmentsLikePlan(validation.planType)
      ? "INSTALLMENTS"
      : "PROMISE_TO_PAY");
  const firstDueDate =
    validation.firstDueDate ||
    toDateOnly(
      effectiveProposal?.first_due_date || effectiveProposal?.firstDueDate,
    );

  if (!firstDueDate) {
    logger.error(
      { caseId, interactionId, planType: validation.planType },
      "createPaymentAgreementFromTool: missing firstDueDate after successful validation",
    );
    await updateInteractionCallStateFromTool({
      interaction,
      nextState: CALL_STATES.CONFIRM_AGREEMENT,
      action: CALL_ACTIONS.CALL_CREATE_PAYMENT_AGREEMENT,
      tool: "create-payment-agreement",
      toolOk: false,
      toolCode: "MISSING_FIRST_DUE_DATE",
    });
    await createCallToolEvent({
      debtCaseId: debtCase.id,
      automationId,
      eventType: "agreement_tool_validation_failed",
      payload: {
        interaction_id: interaction.id,
        code: "MISSING_FIRST_DUE_DATE",
        message: "first_due_date missing after validation",
      },
    });
    return {
      ok: false,
      code: "MISSING_FIRST_DUE_DATE",
      message:
        "first_due_date is required as YYYY-MM-DD. Ask when the debtor can pay (first payment or first installment) and pass it in the create-payment-agreement tool.",
      proposal_source: proposalResolution.source,
      proposal_snapshot_version: proposalResolution.snapshot_version,
      proposal_committed_version: proposalResolution.committed_version,
      current_state: currentState,
      next_state: CALL_STATES.CONFIRM_AGREEMENT,
      speak_back: buildAgreementValidationSpeakBack({
        validation: { code: "MISSING_FIRST_DUE_DATE" },
        currency: debtCase.currency || "USD",
      }),
    };
  }

  let agreement;
  await sequelize.transaction(async (t) => {
    await supersedeOperationalAgreementsForCase(tenantId, debtCase.id, {
      transaction: t,
    });
    agreement = await PaymentAgreement.create(
      {
        tenantId,
        debtCaseId: debtCase.id,
        type: agreementType,
        status: "PENDING",
        totalAmountCents: Number(debtCase.amountDueCents),
        downPaymentCents: validation.upfrontAmountCents,
        installments:
          agreementType === "INSTALLMENTS"
            ? Math.max(1, validation.installmentsCount || 1)
            : null,
        startDate: agreementType === "INSTALLMENTS" ? firstDueDate : null,
        promiseDate: agreementType === "PROMISE_TO_PAY" ? firstDueDate : null,
        provider: "NONE",
        createdBy: "AI",
        terms: {
          plan_type: validation.planType,
          proposal: effectiveProposal,
          proposal_source: proposalResolution.source,
          proposal_snapshot_version: proposalResolution.snapshot_version,
          proposal_committed_version: proposalResolution.committed_version,
          payload_proposal: proposal || null,
          conversation_id: conversationId || null,
          interaction_id: interactionId || null,
          rules_snapshot: rules,
          status: "LINK_SENT",
        },
      },
      { transaction: t }
    );
    await createInstallmentRowsForAgreement(agreement, { transaction: t });
  });

  const paymentLinkUrl = await createPaymentLinkAndGetUrl({
    tenantId,
    debtCaseId: debtCase.id,
    paymentAgreementId: agreement.id,
  });
  await agreement.update({ paymentLinkUrl });

  const resolvedAutomationId = await resolveAutomationIdForCase({
    debtCaseId: debtCase.id,
    automationId,
  });
  await createCollectionEvent({
    automationId: resolvedAutomationId,
    debtCaseId: debtCase.id,
    channel: "call",
    eventType: "agreement_created",
    payload: {
      agreement_id: agreement.id,
      interaction_id: interactionId || null,
      conversation_id: conversationId || null,
      plan_type: validation.planType,
      proposal_source: proposalResolution.source,
      proposal_snapshot_version: proposalResolution.snapshot_version,
    },
  });

  const caseStatus = resolveCaseStatusFromAgreementType(agreementType);
  await debtCase.update({
    status: caseStatus,
    paymentLinkUrl,
    lastContactedAt: new Date(),
    meta: {
      ...(debtCase.meta || {}),
      last_negotiation_channel: "CALL_AI",
      last_agreement_id: agreement.id,
      payment_link_sent_at: new Date().toISOString(),
    },
  });

  const requestedChannel = resolvePreferredDeliveryChannel(effectiveProposal);
  const rawRequestedDeliveryEmail = String(
    effectiveProposal?.delivery_email ||
      effectiveProposal?.deliveryEmail ||
      effectiveProposal?.email ||
      effectiveProposal?.recipient_email ||
      effectiveProposal?.recipientEmail ||
      "",
  ).trim();
  const requestedDeliveryEmail = normalizeEmailCandidate(
    rawRequestedDeliveryEmail,
  );
  const effectiveDeliveryEmail =
    requestedDeliveryEmail ||
    (!rawRequestedDeliveryEmail
      ? normalizeEmailCandidate(debtCase.debtor?.email)
      : null);
  const hasEmail = Boolean(effectiveDeliveryEmail);
  const hasPhone = Boolean(String(debtCase.debtor?.phone || "").trim());
  let deliveryChannels = [];

  if (requestedChannel === "email") {
    deliveryChannels = hasEmail ? ["email"] : hasPhone ? ["sms"] : [];
  } else if (requestedChannel === "sms") {
    deliveryChannels = hasPhone ? ["sms"] : hasEmail ? ["email"] : [];
  } else if (requestedChannel === "both") {
    deliveryChannels = [
      hasEmail ? "email" : null,
      hasPhone ? "sms" : null,
    ].filter(Boolean);
  } else {
    deliveryChannels = hasEmail ? ["email"] : hasPhone ? ["sms"] : [];
  }

  const tenantDisplayName = await resolveTenantDisplayNameForDelivery({
    tenantId,
    debtCase,
    resolvedPolicy,
  });
  const deliveryResults = [];

  for (const channel of deliveryChannels) {
    if (channel === "email") {
      const attributedLink = appendPaymentLinkAttribution(
        paymentLinkUrl,
        channel,
        resolvedAutomationId,
      );
      // eslint-disable-next-line no-await-in-loop
      deliveryResults.push(
        await sendCaseLinkEmail({
          tenantId,
          debtCaseId: debtCase.id,
          debtor: debtCase.debtor,
          deliveryEmail: effectiveDeliveryEmail,
          deliveryEmailRaw: rawRequestedDeliveryEmail || null,
          paymentLinkUrl: attributedLink,
          tenantName: tenantDisplayName,
          automationId: resolvedAutomationId,
          context: "agreement",
          agreementId: agreement.id,
        }),
      );
      continue;
    }
    if (channel === "sms") {
      // eslint-disable-next-line no-await-in-loop
      deliveryResults.push(
        await sendCaseLinkSms({
          tenantId,
          debtCaseId: debtCase.id,
          debtor: debtCase.debtor,
          paymentLinkUrl,
          tenantName: tenantDisplayName,
          automationId: resolvedAutomationId,
          context: "agreement",
          agreementId: agreement.id,
        }),
      );
    }
  }

  const successfulDeliveries = deliveryResults.filter((result) => result.ok);
  const failedDeliveries = deliveryResults.filter((result) => !result.ok);

  if (successfulDeliveries.length > 0) {
    await agreement.update({ status: "ACTIVE" });
  }

  const sentByEmail = successfulDeliveries.some(
    (result) => result.channel === "email",
  );
  const sentBySms = successfulDeliveries.some(
    (result) => result.channel === "sms",
  );
  let speakBack =
    "Perfect. Your agreement is registered and your secure payment link is ready. I can resend it by email or SMS.";
  if (sentByEmail && sentBySms) {
    speakBack = effectiveDeliveryEmail
      ? `Perfect. I sent your secure link by email to ${effectiveDeliveryEmail} and by SMS. Please confirm you received it.`
      : "Perfect. I sent your secure link by email and by SMS. Please confirm you received it.";
  } else if (sentByEmail) {
    speakBack = effectiveDeliveryEmail
      ? `Perfect. I sent your secure link to ${effectiveDeliveryEmail}. Please confirm you received it.`
      : "Perfect. I sent your secure link by email. Please confirm you received it.";
  } else if (sentBySms) {
    speakBack =
      "Perfect. I sent your secure link by SMS. Please confirm you received it.";
  }

  await updateInteractionCallStateFromTool({
    interaction,
    nextState: CALL_STATES.POST_DELIVERY_CONFIRM,
    action: CALL_ACTIONS.CALL_CREATE_PAYMENT_AGREEMENT,
    tool: "create-payment-agreement",
    toolOk: true,
    toolCode: null,
    closingContext: "agreement_created",
    facts: {
      last_delivery_result: {
        requested_channel: requestedChannel,
        attempted_channels: deliveryChannels,
        successful_channels: successfulDeliveries.map((d) => d.channel),
        failed_channels: failedDeliveries.map((d) => ({
          channel: d.channel,
          reason: d.reason || null,
        })),
        email: effectiveDeliveryEmail || null,
      },
      last_committed_plan: {
        plan_type: validation.planType,
        upfront_amount_cents: validation.upfrontAmountCents,
        installments_count: validation.installmentsCount || null,
        delivery_channel: requestedChannel,
        first_due_date: firstDueDate || null,
      },
    },
  });
  await createCallToolEvent({
    debtCaseId: debtCase.id,
    automationId: resolvedAutomationId,
    eventType: "agreement_tool_executed",
    payload: {
      interaction_id: interaction.id,
      agreement_id: agreement.id,
      case_status: caseStatus,
      proposal_source: proposalResolution.source,
      proposal_snapshot_version: proposalResolution.snapshot_version,
    },
  });

  return {
    ok: true,
    agreement_id: agreement.id,
    payment_link_url: paymentLinkUrl,
    proposal: effectiveProposal,
    proposal_source: proposalResolution.source,
    proposal_snapshot_version: proposalResolution.snapshot_version,
    proposal_committed_version: proposalResolution.committed_version,
    email_sent: sentByEmail,
    sms_sent: sentBySms,
    link_delivery: {
      requested_channel: requestedChannel,
      attempted_channels: deliveryChannels,
      successful_channels: successfulDeliveries.map((d) => d.channel),
      email: effectiveDeliveryEmail || null,
      failed_channels: failedDeliveries.map((d) => ({
        channel: d.channel,
        reason: d.reason || null,
      })),
    },
    case_status: caseStatus,
    current_state: currentState,
    next_state: CALL_STATES.POST_DELIVERY_CONFIRM,
    speak_back: speakBack,
  };
};

export const createDisputeFromTool = async ({
  tenantId,
  caseId,
  interactionId,
  conversationId,
  automationId,
  proposal,
}) => {
  const debtCase = await DebtCase.findOne({
    where: { id: caseId, tenantId },
    include: [{ model: Debtor, as: "debtor" }],
  });

  if (!debtCase) {
    return {
      ok: false,
      code: "CASE_NOT_FOUND",
      message: "Debt case not found for the provided tenant_id and case_id.",
    };
  }

  const interaction = await resolveToolInteractionContext({
    tenantId,
    caseId: debtCase.id,
    interactionId,
  });
  if (!interaction) {
    return {
      ok: false,
      code: "INTERACTION_NOT_FOUND",
      message: "Call interaction was not found for the provided context.",
    };
  }

  const currentState = resolveCallStateFromInteraction(interaction);
  if (!DISPUTE_ALLOWED_FSM_STATES.has(currentState)) {
    const expectedStates = Array.from(DISPUTE_ALLOWED_FSM_STATES);
    await updateInteractionCallStateFromTool({
      interaction,
      nextState: currentState,
      action: CALL_ACTIONS.NONE,
      tool: "create-dispute",
      toolOk: false,
      toolCode: "INVALID_STATE_FOR_TOOL",
    });
    await createCallToolEvent({
      debtCaseId: debtCase.id,
      automationId,
      eventType: "dispute_tool_rejected_invalid_state",
      payload: {
        interaction_id: interaction.id,
        current_state: currentState,
        expected_states: expectedStates,
      },
    });
    return {
      ok: false,
      code: "INVALID_STATE_FOR_TOOL",
      message: `create-dispute is only allowed in states: ${expectedStates.join(", ")}`,
      current_state: currentState,
      expected_states: expectedStates,
    };
  }

  const proposalResolution = resolveDisputeProposalForExecution({
    interaction,
    proposal,
  });
  const effectiveProposal = proposalResolution.proposal;

  const reason = normalizeDisputeReason(
    effectiveProposal?.reason ||
      effectiveProposal?.dispute_reason ||
      effectiveProposal?.disputeReason ||
      "OTHER",
  );
  const notes = truncateString(
    effectiveProposal?.notes ||
      effectiveProposal?.summary ||
      effectiveProposal?.details ||
      "",
    2000,
  );
  const evidenceUrlsRaw =
    effectiveProposal?.evidence_urls ||
    effectiveProposal?.evidenceUrls ||
    effectiveProposal?.evidence_url ||
    [];
  const evidenceUrls = (
    Array.isArray(evidenceUrlsRaw) ? evidenceUrlsRaw : [evidenceUrlsRaw]
  )
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 10);

  let dispute = await CaseDispute.findOne({
    where: { tenantId, debtCaseId: debtCase.id, status: "OPEN" },
    order: [["createdAt", "DESC"]],
  });

  let disputeCreated = false;
  if (!dispute) {
    dispute = await CaseDispute.create({
      tenantId,
      debtCaseId: debtCase.id,
      status: "OPEN",
      reason,
      notes: notes || null,
      evidenceUrls,
      openedBy: null,
      openedAt: new Date(),
    });
    disputeCreated = true;
  }

  const resolvedAutomationId = await resolveAutomationIdForCase({
    debtCaseId: debtCase.id,
    automationId,
  });

  await createCollectionEvent({
    automationId: resolvedAutomationId,
    debtCaseId: debtCase.id,
    channel: "call",
    eventType: disputeCreated ? "dispute_created" : "dispute_already_open",
    payload: {
      dispute_id: dispute.id,
      interaction_id: interactionId || null,
      conversation_id: conversationId || null,
      reason: dispute.reason,
      proposal_source: proposalResolution.source,
      proposal_snapshot_version: proposalResolution.snapshot_version,
    },
  });

  await debtCase.update({
    meta: {
      ...(debtCase.meta || {}),
      last_dispute_id: dispute.id,
      last_dispute_reason: dispute.reason,
      last_dispute_opened_at: new Date().toISOString(),
      last_negotiation_channel: "CALL_AI",
    },
  });

  const requestedChannel = resolvePreferredDeliveryChannel(effectiveProposal);
  const rawRequestedDeliveryEmail = String(
    effectiveProposal?.delivery_email ||
      effectiveProposal?.deliveryEmail ||
      effectiveProposal?.email ||
      effectiveProposal?.recipient_email ||
      effectiveProposal?.recipientEmail ||
      "",
  ).trim();
  const requestedDeliveryEmail = normalizeEmailCandidate(
    rawRequestedDeliveryEmail,
  );
  const effectiveDeliveryEmail =
    requestedDeliveryEmail ||
    (!rawRequestedDeliveryEmail
      ? normalizeEmailCandidate(debtCase.debtor?.email)
      : null);
  const hasEmail = Boolean(effectiveDeliveryEmail);
  const hasPhone = Boolean(String(debtCase.debtor?.phone || "").trim());
  let deliveryChannels = [];

  if (requestedChannel === "email") {
    deliveryChannels = hasEmail ? ["email"] : hasPhone ? ["sms"] : [];
  } else if (requestedChannel === "sms") {
    deliveryChannels = hasPhone ? ["sms"] : hasEmail ? ["email"] : [];
  } else if (requestedChannel === "both") {
    deliveryChannels = [
      hasEmail ? "email" : null,
      hasPhone ? "sms" : null,
    ].filter(Boolean);
  } else {
    deliveryChannels = hasEmail ? ["email"] : hasPhone ? ["sms"] : [];
  }

  const paymentLinkUrl = await createPaymentLinkAndGetUrl({
    tenantId,
    debtCaseId: debtCase.id,
    paymentAgreementId: debtCase?.meta?.last_agreement_id || null,
  });

  const tenantDisplayName = await resolveTenantDisplayNameForDelivery({
    tenantId,
    debtCase,
  });
  const shouldSendLink = parseBoolean(
    effectiveProposal?.send_link ||
      effectiveProposal?.sendLink ||
      effectiveProposal?.include_link,
    true,
  );
  const deliveryResults = [];

  if (shouldSendLink) {
    for (const channel of deliveryChannels) {
      if (channel === "email") {
        const attributedLink = appendPaymentLinkAttribution(
          paymentLinkUrl,
          channel,
          resolvedAutomationId,
        );
        // eslint-disable-next-line no-await-in-loop
        deliveryResults.push(
          await sendCaseLinkEmail({
            tenantId,
            debtCaseId: debtCase.id,
            debtor: debtCase.debtor,
            deliveryEmail: effectiveDeliveryEmail,
            deliveryEmailRaw: rawRequestedDeliveryEmail || null,
            paymentLinkUrl: attributedLink,
            tenantName: tenantDisplayName,
            automationId: resolvedAutomationId,
            context: "dispute",
            disputeId: dispute.id,
          }),
        );
        continue;
      }

      if (channel === "sms") {
        // eslint-disable-next-line no-await-in-loop
        deliveryResults.push(
          await sendCaseLinkSms({
            tenantId,
            debtCaseId: debtCase.id,
            debtor: debtCase.debtor,
            paymentLinkUrl,
            tenantName: tenantDisplayName,
            automationId: resolvedAutomationId,
            context: "dispute",
            disputeId: dispute.id,
          }),
        );
      }
    }
  }

  const successfulDeliveries = deliveryResults.filter((result) => result.ok);
  const failedDeliveries = deliveryResults.filter((result) => !result.ok);
  const sentByEmail = successfulDeliveries.some(
    (result) => result.channel === "email",
  );
  const sentBySms = successfulDeliveries.some(
    (result) => result.channel === "sms",
  );

  let speakBack =
    "Understood. I registered your dispute and paused negotiation while the team reviews your case.";
  if (shouldSendLink && sentByEmail && sentBySms) {
    speakBack = effectiveDeliveryEmail
      ? `Understood. I registered your dispute and sent your secure case link to ${effectiveDeliveryEmail} and by SMS. Please confirm you received it.`
      : "Understood. I registered your dispute and sent your secure case link by email and SMS. Please confirm you received it.";
  } else if (shouldSendLink && sentByEmail) {
    speakBack = effectiveDeliveryEmail
      ? `Understood. I registered your dispute and sent your secure case link to ${effectiveDeliveryEmail}. Please confirm you received it.`
      : "Understood. I registered your dispute and sent your secure case link by email. Please confirm you received it.";
  } else if (shouldSendLink && sentBySms) {
    speakBack =
      "Understood. I registered your dispute and sent your secure case link by SMS. Please confirm you received it.";
  } else if (shouldSendLink && deliveryChannels.length === 0) {
    speakBack =
      "Understood. I registered your dispute, but I could not send a link because contact details are missing.";
  }

  await updateInteractionCallStateFromTool({
    interaction,
    nextState: CALL_STATES.POST_DISPUTE_CONFIRM,
    action: CALL_ACTIONS.CALL_CREATE_DISPUTE,
    tool: "create-dispute",
    toolOk: true,
    toolCode: null,
    closingContext: "dispute_registered",
    facts: {
      last_delivery_result: {
        requested_channel: requestedChannel,
        attempted_channels: shouldSendLink ? deliveryChannels : [],
        successful_channels: successfulDeliveries.map((d) => d.channel),
        failed_channels: failedDeliveries.map((d) => ({
          channel: d.channel,
          reason: d.reason || null,
        })),
        email: effectiveDeliveryEmail || null,
      },
      last_dispute_summary: {
        dispute_id: dispute.id,
        reason: dispute.reason,
        notes: dispute.notes || null,
        send_link: shouldSendLink,
      },
    },
  });
  await createCallToolEvent({
    debtCaseId: debtCase.id,
    automationId: resolvedAutomationId,
    eventType: "dispute_tool_executed",
    payload: {
      interaction_id: interaction.id,
      dispute_id: dispute.id,
      dispute_reason: dispute.reason,
      proposal_source: proposalResolution.source,
      proposal_snapshot_version: proposalResolution.snapshot_version,
    },
  });

  return {
    ok: true,
    dispute_id: dispute.id,
    dispute_status: dispute.status,
    dispute_reason: dispute.reason,
    proposal: effectiveProposal,
    proposal_source: proposalResolution.source,
    proposal_snapshot_version: proposalResolution.snapshot_version,
    proposal_committed_version: proposalResolution.committed_version,
    payment_link_url: paymentLinkUrl,
    email_sent: sentByEmail,
    sms_sent: sentBySms,
    link_delivery: {
      requested_channel: requestedChannel,
      attempted_channels: shouldSendLink ? deliveryChannels : [],
      successful_channels: successfulDeliveries.map((d) => d.channel),
      email: effectiveDeliveryEmail || null,
      failed_channels: failedDeliveries.map((d) => ({
        channel: d.channel,
        reason: d.reason || null,
      })),
    },
    current_state: currentState,
    next_state: CALL_STATES.POST_DISPUTE_CONFIRM,
    speak_back: speakBack,
  };
};
