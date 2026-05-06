import { CALL_DIALOG_ACTIONS } from "../nlu/action-classifier.service.js";
import { isInstallmentsLikePlan } from "../policy/plan-catalog.service.js";

export const DEFAULT_CALL_SLOTS = Object.freeze({
  identity_verified: null,
  dispute_detected: false,
  dispute_reason: null,
  plan_type: null,
  upfront_amount_cents: null,
  installments_count: null,
  delivery_channel: null,
  delivery_email: null,
  /** YYYY-MM-DD — first payment / first installment date for negotiated agreement */
  first_due_date: null,
  agreement_confirmed: null,
  callback_requested: false,
  goodbye: false,
});

const PROPOSAL_EMPTY_KEYS = new Set([undefined, null, ""]);

const isMeaningfulValue = (value) => {
  if (PROPOSAL_EMPTY_KEYS.has(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

export const deriveSlotPatchFromAction = (action) => {
  switch (action) {
    case CALL_DIALOG_ACTIONS.VERIFY_IDENTITY_YES:
      return { identity_verified: true };
    case CALL_DIALOG_ACTIONS.VERIFY_IDENTITY_NO:
      return { identity_verified: false };
    case CALL_DIALOG_ACTIONS.CONFIRM_AGREEMENT:
      return { agreement_confirmed: true };
    case CALL_DIALOG_ACTIONS.REJECT_AGREEMENT:
      return { agreement_confirmed: false };
    case CALL_DIALOG_ACTIONS.OPEN_DISPUTE:
      return { dispute_detected: true };
    case CALL_DIALOG_ACTIONS.REQUEST_CALLBACK:
      return { callback_requested: true };
    case CALL_DIALOG_ACTIONS.END_CALL:
      return { goodbye: true };
    default:
      return {};
  }
};

export const mergeCallSlots = ({ previousSlots = {}, patch = {} }) => ({
  ...DEFAULT_CALL_SLOTS,
  ...(previousSlots && typeof previousSlots === "object" ? previousSlots : {}),
  ...(patch && typeof patch === "object" ? patch : {}),
});

export const sanitizeCallSlots = ({ slots = {} }) => {
  const next = { ...DEFAULT_CALL_SLOTS, ...(slots || {}) };

  if (!next.dispute_detected) {
    next.dispute_reason = null;
  } else if (!next.dispute_reason) {
    next.dispute_reason = "OTHER";
  }

  if (next.identity_verified !== true) {
    next.plan_type = null;
    next.upfront_amount_cents = null;
    next.installments_count = null;
    next.delivery_channel = null;
    next.delivery_email = null;
    next.first_due_date = null;
    next.agreement_confirmed = null;
    next.dispute_detected = false;
    next.dispute_reason = null;
  }

  return next;
};

export const applyAgreementDefaults = ({
  slots = {},
  planCatalog,
  balanceCents,
  allowedDeliveryChannels = [],
}) => {
  const next = { ...slots };
  const plansByCode = planCatalog?.plansByCode || {};
  const planType = String(next.plan_type || "")
    .trim()
    .toUpperCase();
  const plan = plansByCode[planType] || null;
  const safeBalance = Number(balanceCents || 0);

  if (
    plan &&
    (!next.upfront_amount_cents || Number(next.upfront_amount_cents) <= 0)
  ) {
    const defaultPct = Number(plan.minUpfrontPct || 0);
    const defaultAmount =
      planType === "FULL"
        ? safeBalance
        : Math.ceil((Math.max(0, defaultPct) / 100) * safeBalance);
    if (defaultAmount > 0) {
      next.upfront_amount_cents = defaultAmount;
    }
  }

  if (plan?.requiresInstallments || isInstallmentsLikePlan(planType)) {
    const maxInstallments = Number(
      plan?.maxInstallments || planCatalog?.maxInstallments || 0,
    );
    if (!next.installments_count || Number(next.installments_count) <= 0) {
      next.installments_count = Math.max(1, maxInstallments || 1);
    } else if (
      maxInstallments > 0 &&
      Number(next.installments_count) > maxInstallments
    ) {
      next.installments_count = maxInstallments;
    }
  } else {
    next.installments_count = null;
  }

  if (
    next.delivery_channel &&
    Array.isArray(allowedDeliveryChannels) &&
    allowedDeliveryChannels.length > 0 &&
    !allowedDeliveryChannels.includes(next.delivery_channel)
  ) {
    next.delivery_channel = null;
  }

  if (
    !next.delivery_channel &&
    Array.isArray(allowedDeliveryChannels) &&
    allowedDeliveryChannels.length === 1
  ) {
    [next.delivery_channel] = allowedDeliveryChannels;
  }

  return next;
};

const serializeStable = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeStable(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const sortedKeys = Object.keys(value).sort();
    return `{${sortedKeys.map((key) => `${key}:${serializeStable(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
};

export const countSlotOverwrites = ({ previousSlots = {}, nextSlots = {} }) => {
  let overwrites = 0;
  for (const key of Object.keys(DEFAULT_CALL_SLOTS)) {
    const previousValue = previousSlots[key];
    const nextValue = nextSlots[key];
    if (!isMeaningfulValue(previousValue)) continue;
    if (!isMeaningfulValue(nextValue)) continue;
    if (serializeStable(previousValue) !== serializeStable(nextValue)) {
      overwrites += 1;
    }
  }
  return overwrites;
};

const compactObject = (value) =>
  Object.entries(value).reduce((result, [key, fieldValue]) => {
    if (!isMeaningfulValue(fieldValue)) return result;
    result[key] = fieldValue;
    return result;
  }, {});

export const buildAgreementProposalFromSlots = (slots = {}) =>
  compactObject({
    plan_type: slots.plan_type || null,
    upfront_amount_cents: slots.upfront_amount_cents || null,
    installments_count: slots.installments_count || null,
    delivery_channel: slots.delivery_channel || null,
    delivery_email: slots.delivery_email || null,
    first_due_date: slots.first_due_date || null,
  });

export const buildDisputeProposalFromSlots = (slots = {}) =>
  compactObject({
    reason: slots.dispute_reason || null,
    delivery_channel: slots.delivery_channel || null,
    delivery_email: slots.delivery_email || null,
  });

export const hasMeaningfulProposal = (proposal = null) => {
  const source =
    proposal && typeof proposal === "object" && !Array.isArray(proposal)
      ? proposal
      : {};
  return Object.values(source).some((value) => isMeaningfulValue(value));
};

export const proposalsAreEqual = (left = null, right = null) =>
  serializeStable(left) === serializeStable(right);
