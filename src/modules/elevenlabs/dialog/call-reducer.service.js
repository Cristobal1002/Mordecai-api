import { CALL_ACTIONS, CALL_STATES } from "../call-state-machine.js";
import { CALL_DIALOG_ACTIONS } from "../nlu/action-classifier.service.js";
import { isInstallmentsLikePlan } from "../policy/plan-catalog.service.js";
import { validateFirstDueAgainstWindow } from "../negotiation-first-payment-window.service.js";

const toDisplayAmount = (amountCents) => {
  const numeric = Number(amountCents || 0) / 100;
  if (!Number.isFinite(numeric)) return "0.00";
  return numeric.toFixed(2);
};

const humanizePlan = (planCode, planCatalog) => {
  const code = String(planCode || "")
    .trim()
    .toUpperCase();
  const plan = planCatalog?.plansByCode?.[code];
  if (plan?.label) return plan.label;
  if (code === "FULL") return "full amount in one payment";
  if (code === "HALF") return "half now and remainder later";
  if (isInstallmentsLikePlan(code)) {
    const maxInstallments = Number(planCatalog?.maxInstallments || 4);
    return `installments up to ${maxInstallments}`;
  }
  return code.toLowerCase();
};

const humanizeAllowedPlans = (planCatalog) => {
  const plans = Array.isArray(planCatalog?.allowedPlanTypes)
    ? planCatalog.allowedPlanTypes
    : [];
  return plans.map((code) => humanizePlan(code, planCatalog)).join(", ");
};

const buildDeliveryOptionsText = (allowedDeliveryChannels = []) => {
  if (
    !Array.isArray(allowedDeliveryChannels) ||
    allowedDeliveryChannels.length === 0
  ) {
    return "email, sms, or both";
  }
  return allowedDeliveryChannels.join(", ");
};

const normalizeFacts = (facts) =>
  facts && typeof facts === "object" && !Array.isArray(facts) ? facts : {};

const buildAgreementSummary = ({ slots, planCatalog, currency, facts = {} }) => {
  const committedPlan =
    normalizeFacts(facts.last_committed_plan) || normalizeFacts(facts.plan);
  const planSource =
    committedPlan.plan_type || committedPlan.planType ? committedPlan : slots;
  const planLabel = humanizePlan(planSource.plan_type, planCatalog);
  const upfrontAmount = toDisplayAmount(planSource.upfront_amount_cents);
  const installmentsChunk =
    planSource.installments_count && Number(planSource.installments_count) > 0
      ? `, installments ${planSource.installments_count}`
      : "";
  const deliveryChannel =
    planSource.delivery_channel || committedPlan.delivery_channel || "email";
  const dueRaw =
    planSource.first_due_date ||
    slots?.first_due_date ||
    committedPlan.first_due_date;
  const dueChunk =
    dueRaw && String(dueRaw).trim()
      ? `, first payment on ${String(dueRaw).trim().slice(0, 10)}`
      : "";

  return `Plan ${planLabel}, upfront ${upfrontAmount} ${currency}${installmentsChunk}, delivery channel ${deliveryChannel}${dueChunk}.`;
};

const resolveAgreementProgressState = ({
  slots,
  planCatalog,
  firstPaymentWindow,
}) => {
  const planType = String(slots?.plan_type || "")
    .trim()
    .toUpperCase();
  const plan = planCatalog?.plansByCode?.[planType];

  if (!planType || !planCatalog?.allowedPlanTypes?.includes(planType)) {
    return CALL_STATES.PLAN_SELECTION;
  }

  if (!slots.upfront_amount_cents || Number(slots.upfront_amount_cents) <= 0) {
    return CALL_STATES.CAPTURE_UPFRONT;
  }

  if (
    (plan?.requiresInstallments || isInstallmentsLikePlan(planType)) &&
    (!slots.installments_count || Number(slots.installments_count) <= 0)
  ) {
    return CALL_STATES.CAPTURE_INSTALLMENTS;
  }

  if (!slots.delivery_channel) {
    return CALL_STATES.CAPTURE_DELIVERY_CHANNEL;
  }

  const rawDue =
    slots.first_due_date != null
      ? String(slots.first_due_date).trim().slice(0, 10)
      : "";
  if (!firstPaymentWindow) {
    if (!rawDue || !/^\d{4}-\d{2}-\d{2}$/.test(rawDue)) {
      return CALL_STATES.CAPTURE_FIRST_PAYMENT_DATE;
    }
  } else {
    const v = validateFirstDueAgainstWindow(rawDue, firstPaymentWindow);
    if (!v.ok) {
      return CALL_STATES.CAPTURE_FIRST_PAYMENT_DATE;
    }
  }

  if (slots.agreement_confirmed !== true) {
    return CALL_STATES.CONFIRM_AGREEMENT;
  }

  return CALL_STATES.EXECUTE_AGREEMENT;
};

const buildClosingMessage = ({ tenantName, facts = {} }) => {
  const closingContext = String(facts?.closing_context || "").trim();

  if (closingContext === "agreement_created") {
    return `Thank you for your time today. Your secure link has been sent, and we're here if you need any help. Goodbye.`;
  }

  if (closingContext === "dispute_registered") {
    return `Thank you for explaining that today. We've recorded your dispute and the team will review it as soon as possible. Goodbye.`;
  }

  if (closingContext === "callback_requested") {
    return `Thank you for your time today. We'll follow up with you shortly. Goodbye.`;
  }

  return `Thank you for speaking with ${tenantName}. Take care and goodbye.`;
};

const buildPostDeliveryPrompt = ({ deliveryFacts = {} }) => {
  const successfulChannels = Array.isArray(deliveryFacts.successful_channels)
    ? deliveryFacts.successful_channels
    : [];
  const email = String(deliveryFacts.email || "").trim();

  if (successfulChannels.includes("email") && email) {
    return `I sent it to ${email}. Could you let me know if you received it?`;
  }

  if (successfulChannels.includes("email") && successfulChannels.includes("sms")) {
    return "I sent the secure link by email and by SMS. Could you let me know if you received it?";
  }

  if (successfulChannels.includes("email")) {
    return "I sent the secure link by email. Could you let me know if you received it?";
  }

  if (successfulChannels.includes("sms")) {
    return "I sent the secure link by SMS. Could you let me know if you received it?";
  }

  return "The secure link is ready. Do you need me to clarify anything before we close?";
};

const buildPostDisputePrompt = ({ deliveryFacts = {} }) => {
  const successfulChannels = Array.isArray(deliveryFacts.successful_channels)
    ? deliveryFacts.successful_channels
    : [];
  const email = String(deliveryFacts.email || "").trim();

  if (successfulChannels.includes("email") && email) {
    return `I sent the secure case link to ${email}. Could you let me know if you received it?`;
  }

  if (successfulChannels.includes("email") && successfulChannels.includes("sms")) {
    return "I sent the secure case link by email and by SMS. Could you let me know if you received it?";
  }

  if (successfulChannels.includes("email")) {
    return "I sent the secure case link by email. Could you let me know if you received it?";
  }

  if (successfulChannels.includes("sms")) {
    return "I sent the secure case link by SMS. Could you let me know if you received it?";
  }

  return "Your dispute is registered. Do you need me to clarify anything else before we close?";
};

const buildSentBySummary = (deliveryFacts = {}) => {
  const successfulChannels = Array.isArray(deliveryFacts.successful_channels)
    ? deliveryFacts.successful_channels
    : [];
  const email = String(deliveryFacts.email || "").trim();

  if (successfulChannels.includes("email") && successfulChannels.includes("sms")) {
    return email
      ? `I sent it to ${email} and by SMS.`
      : "I sent it by email and by SMS.";
  }

  if (successfulChannels.includes("email")) {
    return email ? `I sent it to ${email}.` : "I sent it by email.";
  }

  if (successfulChannels.includes("sms")) {
    return "I sent it by SMS.";
  }

  return "I have the secure link ready, but I don't see a successful delivery recorded yet.";
};

const buildBalanceAnswer = ({ balanceAmount, currency, state }) => {
  const followUp =
    state === CALL_STATES.POST_DELIVERY_CONFIRM ||
    state === CALL_STATES.POST_DISPUTE_CONFIRM
      ? " Could you let me know if you received the link?"
      : " Which option works best for you?";

  return `Your current balance is ${balanceAmount} ${currency}.${followUp}`;
};

const buildOptionsAnswer = ({ planCatalog, state }) => {
  const options = humanizeAllowedPlans(planCatalog);
  const followUp =
    state === CALL_STATES.POST_DELIVERY_CONFIRM ||
    state === CALL_STATES.POST_DISPUTE_CONFIRM
      ? " Do you need help with anything else about the link?"
      : " Which option works best for you?";

  return `Your available options are ${options}.${followUp}`;
};

const buildFirstPaymentDateAsk = ({ window, rejected }) => {
  if (!window) {
    return "When can you make your first payment? Please give a specific calendar date, for example using year, month, and day.";
  }
  const earliest = window.minDate
    ? `on or after ${window.minDate}`
    : "from today";
  const latest = window.maxDate
    ? `on or before ${window.maxDate}`
    : "within policy";
  const tz = window.timeZone || "negotiation timezone";
  let err = "";
  if (rejected?.reason === "too_late") {
    err = ` That date is too far out. The latest we can schedule the first payment is ${window.maxDate}.`;
  } else if (rejected?.reason === "too_early") {
    err = ` The first payment cannot be before ${window.minDate}.`;
  } else if (rejected?.reason === "invalid_format") {
    err = " I did not catch a valid date. Please say it again clearly.";
  }
  return `When can you make your first payment? I need a calendar date (${earliest}, ${latest}, ${tz} calendar). It must be within the current agreement rules, including before the end of this calendar month.${err}`;
};

const buildResumePrompt = ({
  returnState,
  debtorName,
  slots,
  planCatalog,
  balanceCents,
  currency,
  allowedDeliveryChannels,
  facts,
  firstPaymentWindow = null,
  firstDueRejected = null,
}) => {
  const deliveryFacts = normalizeFacts(facts.last_delivery_result);
  const disputeSummary = normalizeFacts(facts.last_dispute_summary);

  if (!returnState) {
    return "Let's continue.";
  }

  switch (returnState) {
    case CALL_STATES.VERIFY_IDENTITY:
      return `For privacy, am I speaking with ${debtorName}?`;
    case CALL_STATES.DISCLOSE_DEBT:
    case CALL_STATES.PLAN_SELECTION:
      return "Which option works best for you?";
    case CALL_STATES.CAPTURE_UPFRONT: {
      const plan =
        planCatalog?.plansByCode?.[String(slots?.plan_type || "").toUpperCase()];
      const minPct = Number(plan?.minUpfrontPct || 0);
      const minUpfrontAmount = Math.ceil(
        (Math.max(0, minPct) / 100) * Number(balanceCents || 0),
      );
      return minUpfrontAmount > 0
        ? `Now, please confirm your upfront amount. Minimum is ${toDisplayAmount(minUpfrontAmount)} ${currency}.`
        : "Now, please confirm your upfront payment amount.";
    }
    case CALL_STATES.CAPTURE_INSTALLMENTS: {
      const plan =
        planCatalog?.plansByCode?.[String(slots?.plan_type || "").toUpperCase()];
      const maxInstallments = Number(
        plan?.maxInstallments || planCatalog?.maxInstallments || 4,
      );
      return `Now, how many installments do you prefer? Maximum is ${maxInstallments}.`;
    }
    case CALL_STATES.CAPTURE_DELIVERY_CHANNEL:
      return `Now, please choose a delivery channel: ${buildDeliveryOptionsText(
        allowedDeliveryChannels,
      )}.`;
    case CALL_STATES.CAPTURE_FIRST_PAYMENT_DATE:
      return buildFirstPaymentDateAsk({
        window: firstPaymentWindow,
        rejected: firstDueRejected,
      });
    case CALL_STATES.CONFIRM_AGREEMENT:
      return `${buildAgreementSummary({
        slots,
        planCatalog,
        currency,
        facts,
      })} Please confirm if you want me to create the payment agreement now.`;
    case CALL_STATES.DISPUTE_CAPTURE:
      if (!slots?.dispute_reason) {
        return "Now, please share the main reason for the dispute.";
      }
      if (!slots?.delivery_channel) {
        return `Now, which delivery channel should we use: ${buildDeliveryOptionsText(
          allowedDeliveryChannels,
        )}?`;
      }
      return "Now, would you like me to register the dispute?";
    case CALL_STATES.POST_DELIVERY_CONFIRM:
      return buildPostDeliveryPrompt({ deliveryFacts });
    case CALL_STATES.POST_DISPUTE_CONFIRM:
      if (disputeSummary.reason) {
        return `I registered your dispute and ${buildPostDisputePrompt({
          deliveryFacts,
        }).charAt(0).toLowerCase()}${buildPostDisputePrompt({
          deliveryFacts,
        }).slice(1)}`;
      }
      return buildPostDisputePrompt({ deliveryFacts });
    default:
      return "Let's continue.";
  }
};

const buildInterruptionAnswer = ({
  action,
  returnState,
  facts,
  balanceAmount,
  currency,
  planCatalog,
  slots,
}) => {
  const deliveryFacts = normalizeFacts(facts.last_delivery_result);
  const disputeSummary = normalizeFacts(facts.last_dispute_summary);

  if (
    returnState === CALL_STATES.VERIFY_IDENTITY &&
    [
      CALL_DIALOG_ACTIONS.ASK_BALANCE,
      CALL_DIALOG_ACTIONS.ASK_OPTIONS,
      CALL_DIALOG_ACTIONS.ASK_PLAN_SUMMARY,
    ].includes(action)
  ) {
    return "For privacy, I can discuss account details after identity verification.";
  }

  switch (action) {
    case CALL_DIALOG_ACTIONS.ASK_BALANCE:
      return `Your current balance is ${balanceAmount} ${currency}.`;
    case CALL_DIALOG_ACTIONS.ASK_OPTIONS:
      return `Your available options are ${humanizeAllowedPlans(planCatalog)}.`;
    case CALL_DIALOG_ACTIONS.ASK_PLAN_SUMMARY:
      if (
        [CALL_STATES.DISPUTE_CAPTURE, CALL_STATES.POST_DISPUTE_CONFIRM].includes(
          returnState,
        ) &&
        disputeSummary.reason
      ) {
        return `I have your dispute recorded with reason ${String(
          disputeSummary.reason,
        )
          .toLowerCase()
          .replace(/_/g, " ")}.`;
      }
      return buildAgreementSummary({
        slots,
        planCatalog,
        currency,
        facts,
      });
    case CALL_DIALOG_ACTIONS.ASK_LINK_DESTINATION:
    case CALL_DIALOG_ACTIONS.ASK_LINK_CHANNEL:
      return buildSentBySummary(deliveryFacts);
    case CALL_DIALOG_ACTIONS.CONFIRM_LINK_RECEIPT:
      return "Thank you for confirming that you received it.";
    case CALL_DIALOG_ACTIONS.REPORT_LINK_NOT_RECEIVED:
      return `${buildSentBySummary(
        deliveryFacts,
      )} Please check your inbox, spam folder, or messages.`;
    default:
      return "I can clarify your balance, payment options, agreement summary, or where the link was sent.";
  }
};

const withBaseResult = (state) => ({
  nextState: state,
  toolAction: CALL_ACTIONS.NONE,
  speakBack: "",
  intentLabel: "unknown",
  flags: {
    requestAgreementSnapshot: false,
    commitAgreementProposal: false,
    commitDisputeProposal: false,
    resetAgreementFields: false,
    toolMismatch: false,
  },
});

export const reduceCallState = ({ state, action, slots, context }) => {
  const debtorName = context?.debtorName || "the account holder";
  const tenantName = context?.tenantName || "collections";
  const balanceAmount = toDisplayAmount(context?.balanceCents);
  const currency = context?.currency || "USD";
  const planCatalog = context?.planCatalog || {};
  const allowedDeliveryChannels = Array.isArray(
    context?.allowedDeliveryChannels,
  )
    ? context.allowedDeliveryChannels
    : [];
  const facts = normalizeFacts(context?.facts);
  const firstPaymentWindow = context?.firstPaymentWindow || null;
  const firstDueRejected = context?.firstDueRejected || null;
  const returnState = context?.returnState || null;
  const lastDeliveryResult = normalizeFacts(facts.last_delivery_result);
  const lastDisputeSummary = normalizeFacts(facts.last_dispute_summary);

  const result = withBaseResult(state);

  if (
    action === CALL_DIALOG_ACTIONS.REQUEST_CALLBACK ||
    slots?.callback_requested === true
  ) {
    result.nextState = CALL_STATES.CLOSE;
    result.toolAction = CALL_ACTIONS.END_CALL;
    result.speakBack =
      "Understood. I'll arrange a callback for you. Thank you for your time today. Goodbye.";
    result.intentLabel = "callback_requested";
    result.flags.callbackRequested = true;
    return result;
  }

  if (action === CALL_DIALOG_ACTIONS.END_CALL || slots?.goodbye === true) {
    result.nextState = CALL_STATES.CLOSE;
    result.toolAction = CALL_ACTIONS.END_CALL;
    result.speakBack = buildClosingMessage({ tenantName, facts });
    result.intentLabel = "goodbye";
    return result;
  }

  if (state === CALL_STATES.CLOSE) {
    result.nextState = CALL_STATES.CLOSE;
    result.toolAction = CALL_ACTIONS.END_CALL;
    result.speakBack = buildClosingMessage({ tenantName, facts });
    result.intentLabel = "already_closed";
    return result;
  }

  if (state === CALL_STATES.INTERRUPTION) {
    result.nextState = CALL_STATES.INTERRUPTION;
    result.speakBack = `${buildInterruptionAnswer({
      action,
      returnState,
      facts,
      balanceAmount,
      currency,
      planCatalog,
      slots,
    })} ${buildResumePrompt({
      returnState,
      debtorName,
      slots,
      planCatalog,
      balanceCents: context?.balanceCents,
      currency,
      allowedDeliveryChannels,
      facts,
      firstPaymentWindow,
      firstDueRejected,
    })}`;
    result.intentLabel = "interruption_answered";
    return result;
  }

  if (state === CALL_STATES.VERIFY_IDENTITY) {
    if (
      action === CALL_DIALOG_ACTIONS.VERIFY_IDENTITY_NO ||
      slots?.identity_verified === false
    ) {
      result.nextState = CALL_STATES.CLOSE;
      result.toolAction = CALL_ACTIONS.END_CALL;
      result.speakBack = `Understood. I can't discuss account details without identity verification for ${debtorName}. Thank you for your time. Goodbye.`;
      result.intentLabel = "identity_denied";
      return result;
    }

    if (
      action === CALL_DIALOG_ACTIONS.VERIFY_IDENTITY_YES ||
      slots?.identity_verified === true
    ) {
      result.nextState = CALL_STATES.DISCLOSE_DEBT;
      result.speakBack =
        `This is an attempt to collect a debt and any information obtained will be used for that purpose. ` +
        `Your current balance is ${balanceAmount} ${currency}. ` +
        `Available plans are: ${humanizeAllowedPlans(planCatalog)}. Which option works for you?`;
      result.intentLabel = "identity_confirmed";
      return result;
    }

    result.nextState = CALL_STATES.VERIFY_IDENTITY;
    result.speakBack = `For privacy, I need to verify identity first. Am I speaking with ${debtorName}?`;
    result.intentLabel = "identity_pending";
    return result;
  }

  if (slots?.identity_verified !== true) {
    result.nextState = CALL_STATES.VERIFY_IDENTITY;
    result.speakBack = `For privacy, I need to verify identity first. Am I speaking with ${debtorName}?`;
    result.intentLabel = "identity_pending";
    return result;
  }

  if (action === CALL_DIALOG_ACTIONS.ASK_BALANCE) {
    result.nextState = state;
    result.speakBack = buildBalanceAnswer({ balanceAmount, currency, state });
    result.intentLabel = "balance_answered";
    return result;
  }

  if (action === CALL_DIALOG_ACTIONS.ASK_OPTIONS) {
    result.nextState = state;
    result.speakBack = buildOptionsAnswer({ planCatalog, state });
    result.intentLabel = "options_answered";
    return result;
  }

  if (state === CALL_STATES.POST_DELIVERY_CONFIRM) {
    if (action === CALL_DIALOG_ACTIONS.ASK_LINK_DESTINATION) {
      result.nextState = CALL_STATES.POST_DELIVERY_CONFIRM;
      result.speakBack = `${buildSentBySummary(lastDeliveryResult)} Could you let me know if you received it?`;
      result.intentLabel = "delivery_destination_answered";
      return result;
    }

    if (action === CALL_DIALOG_ACTIONS.ASK_LINK_CHANNEL) {
      result.nextState = CALL_STATES.POST_DELIVERY_CONFIRM;
      result.speakBack = `${buildSentBySummary(lastDeliveryResult)} Could you let me know if you received it?`;
      result.intentLabel = "delivery_channel_answered";
      return result;
    }

    if (action === CALL_DIALOG_ACTIONS.ASK_PLAN_SUMMARY) {
      result.nextState = CALL_STATES.POST_DELIVERY_CONFIRM;
      result.speakBack = `${buildAgreementSummary({
        slots,
        planCatalog,
        currency,
        facts,
      })} ${buildPostDeliveryPrompt({
        deliveryFacts: lastDeliveryResult,
      })}`;
      result.intentLabel = "plan_summary_answered";
      return result;
    }

    if (action === CALL_DIALOG_ACTIONS.REPORT_LINK_NOT_RECEIVED) {
      result.nextState = CALL_STATES.POST_DELIVERY_CONFIRM;
      result.speakBack = `${buildSentBySummary(
        lastDeliveryResult,
      )} Please check your inbox, spam folder, or messages. If you still don't see it, I can arrange a callback.`;
      result.intentLabel = "delivery_not_received";
      return result;
    }

    if (action === CALL_DIALOG_ACTIONS.CONFIRM_LINK_RECEIPT) {
      result.nextState = CALL_STATES.CLOSE;
      result.toolAction = CALL_ACTIONS.END_CALL;
      result.speakBack = buildClosingMessage({
        tenantName,
        facts: {
          ...facts,
          closing_context: facts.closing_context || "agreement_created",
        },
      });
      result.intentLabel = "delivery_received";
      return result;
    }

    result.nextState = CALL_STATES.POST_DELIVERY_CONFIRM;
    result.speakBack = buildPostDeliveryPrompt({
      deliveryFacts: lastDeliveryResult,
    });
    result.intentLabel = "post_delivery_follow_up";
    return result;
  }

  if (state === CALL_STATES.POST_DISPUTE_CONFIRM) {
    if (
      action === CALL_DIALOG_ACTIONS.ASK_LINK_DESTINATION ||
      action === CALL_DIALOG_ACTIONS.ASK_LINK_CHANNEL
    ) {
      result.nextState = CALL_STATES.POST_DISPUTE_CONFIRM;
      result.speakBack = `${buildSentBySummary(lastDeliveryResult)} Could you let me know if you received it?`;
      result.intentLabel = "dispute_delivery_answered";
      return result;
    }

    if (action === CALL_DIALOG_ACTIONS.ASK_PLAN_SUMMARY) {
      result.nextState = CALL_STATES.POST_DISPUTE_CONFIRM;
      result.speakBack =
        lastDisputeSummary.reason
          ? `I registered your dispute with reason ${String(
              lastDisputeSummary.reason,
            )
              .toLowerCase()
              .replace(/_/g, " ")}. ${buildPostDisputePrompt({
              deliveryFacts: lastDeliveryResult,
            })}`
          : buildPostDisputePrompt({ deliveryFacts: lastDeliveryResult });
      result.intentLabel = "dispute_summary_answered";
      return result;
    }

    if (action === CALL_DIALOG_ACTIONS.REPORT_LINK_NOT_RECEIVED) {
      result.nextState = CALL_STATES.POST_DISPUTE_CONFIRM;
      result.speakBack = `${buildSentBySummary(
        lastDeliveryResult,
      )} Please check your inbox, spam folder, or messages. If you still don't see it, I can arrange a callback for you.`;
      result.intentLabel = "dispute_delivery_not_received";
      return result;
    }

    if (action === CALL_DIALOG_ACTIONS.CONFIRM_LINK_RECEIPT) {
      result.nextState = CALL_STATES.CLOSE;
      result.toolAction = CALL_ACTIONS.END_CALL;
      result.speakBack = buildClosingMessage({
        tenantName,
        facts: {
          ...facts,
          closing_context: facts.closing_context || "dispute_registered",
        },
      });
      result.intentLabel = "dispute_delivery_received";
      return result;
    }

    result.nextState = CALL_STATES.POST_DISPUTE_CONFIRM;
    result.speakBack = buildPostDisputePrompt({
      deliveryFacts: lastDeliveryResult,
    });
    result.intentLabel = "post_dispute_follow_up";
    return result;
  }

  if (action === CALL_DIALOG_ACTIONS.ASK_PLAN_SUMMARY) {
    result.nextState = state;
    result.speakBack = `${buildAgreementSummary({
      slots,
      planCatalog,
      currency,
      facts,
    })} What would you like to do next?`;
    result.intentLabel = "plan_summary_answered";
    return result;
  }

  const disputeFlowRequested =
    action === CALL_DIALOG_ACTIONS.OPEN_DISPUTE ||
    action === CALL_DIALOG_ACTIONS.PROVIDE_DISPUTE_REASON ||
    slots?.dispute_detected === true ||
    [CALL_STATES.DISPUTE_CAPTURE, CALL_STATES.EXECUTE_DISPUTE].includes(state);

  if (disputeFlowRequested) {
    if (!slots?.dispute_reason) {
      result.nextState = CALL_STATES.DISPUTE_CAPTURE;
      result.speakBack =
        "Understood. I can register your dispute. Please share the main reason: paid already, wrong amount, wrong debtor, lease ended, legal review, or other.";
      result.intentLabel = "dispute_reason_pending";
      return result;
    }

    if (!slots?.delivery_channel) {
      result.nextState = CALL_STATES.DISPUTE_CAPTURE;
      result.speakBack = `Understood. Which delivery channel should we use: ${buildDeliveryOptionsText(
        allowedDeliveryChannels,
      )}?`;
      result.intentLabel = "dispute_channel_pending";
      return result;
    }

    result.nextState = CALL_STATES.EXECUTE_DISPUTE;
    result.toolAction = CALL_ACTIONS.CALL_CREATE_DISPUTE;
    result.speakBack = "Understood. I'll register the dispute now.";
    result.intentLabel = "dispute_ready_to_execute";
    result.flags.commitDisputeProposal = true;
    return result;
  }

  if (
    state === CALL_STATES.CONFIRM_AGREEMENT &&
    (action === CALL_DIALOG_ACTIONS.REJECT_AGREEMENT ||
      slots?.agreement_confirmed === false)
  ) {
    result.nextState = CALL_STATES.PLAN_SELECTION;
    result.speakBack = `No problem. Please choose the plan again: ${humanizeAllowedPlans(
      planCatalog,
    )}.`;
    result.intentLabel = "agreement_rejected";
    result.flags.resetAgreementFields = true;
    return result;
  }

  if (
    state === CALL_STATES.DISCLOSE_DEBT &&
    !slots?.plan_type &&
    action === CALL_DIALOG_ACTIONS.UNKNOWN
  ) {
    result.nextState = CALL_STATES.PLAN_SELECTION;
    result.speakBack = `Please choose one allowed plan: ${humanizeAllowedPlans(planCatalog)}.`;
    result.intentLabel = "plan_pending";
    return result;
  }

  const progressState = resolveAgreementProgressState({
    slots,
    planCatalog,
    firstPaymentWindow,
  });

  if (progressState === CALL_STATES.PLAN_SELECTION) {
    result.nextState = CALL_STATES.PLAN_SELECTION;
    result.speakBack = `Please choose one allowed plan: ${humanizeAllowedPlans(planCatalog)}.`;
    result.intentLabel = "plan_pending";
    return result;
  }

  if (progressState === CALL_STATES.CAPTURE_UPFRONT) {
    const plan =
      planCatalog?.plansByCode?.[String(slots?.plan_type || "").toUpperCase()];
    const minPct = Number(plan?.minUpfrontPct || 0);
    const minUpfrontAmount = Math.ceil(
      (Math.max(0, minPct) / 100) * Number(context?.balanceCents || 0),
    );
    result.nextState = CALL_STATES.CAPTURE_UPFRONT;
    result.speakBack =
      minUpfrontAmount > 0
        ? `Please confirm your upfront amount. Minimum is ${toDisplayAmount(minUpfrontAmount)} ${currency}.`
        : "Please confirm your upfront payment amount.";
    result.intentLabel = "upfront_pending";
    return result;
  }

  if (progressState === CALL_STATES.CAPTURE_INSTALLMENTS) {
    const plan =
      planCatalog?.plansByCode?.[String(slots?.plan_type || "").toUpperCase()];
    const maxInstallments = Number(
      plan?.maxInstallments || planCatalog?.maxInstallments || 4,
    );
    result.nextState = CALL_STATES.CAPTURE_INSTALLMENTS;
    result.speakBack = `How many installments do you prefer? Maximum is ${maxInstallments}.`;
    result.intentLabel = "installments_pending";
    return result;
  }

  if (progressState === CALL_STATES.CAPTURE_DELIVERY_CHANNEL) {
    result.nextState = CALL_STATES.CAPTURE_DELIVERY_CHANNEL;
    result.speakBack = `Please choose a delivery channel: ${buildDeliveryOptionsText(
      allowedDeliveryChannels,
    )}.`;
    result.intentLabel = "channel_pending";
    return result;
  }

  if (progressState === CALL_STATES.CAPTURE_FIRST_PAYMENT_DATE) {
    result.nextState = CALL_STATES.CAPTURE_FIRST_PAYMENT_DATE;
    result.speakBack = buildFirstPaymentDateAsk({
      window: firstPaymentWindow,
      rejected: firstDueRejected,
    });
    result.intentLabel = "first_payment_date_pending";
    result.flags.requestAgreementSnapshot = true;
    return result;
  }

  if (progressState === CALL_STATES.CONFIRM_AGREEMENT) {
    result.nextState = CALL_STATES.CONFIRM_AGREEMENT;
    result.speakBack =
      `${buildAgreementSummary({ slots, planCatalog, currency, facts })} ` +
      "Please confirm if you want me to create the payment agreement now.";
    result.intentLabel = "agreement_pending_confirmation";
    result.flags.requestAgreementSnapshot = true;
    return result;
  }

  if (progressState === CALL_STATES.EXECUTE_AGREEMENT) {
    if (
      ![
        CALL_STATES.CONFIRM_AGREEMENT,
        CALL_STATES.EXECUTE_AGREEMENT,
        CALL_STATES.CAPTURE_FIRST_PAYMENT_DATE,
      ].includes(state)
    ) {
      result.nextState = CALL_STATES.CONFIRM_AGREEMENT;
      result.speakBack =
        `${buildAgreementSummary({ slots, planCatalog, currency, facts })} ` +
        "Please confirm if you want me to create the payment agreement now.";
      result.intentLabel = "agreement_pending_confirmation";
      result.flags.requestAgreementSnapshot = true;
      return result;
    }

    result.nextState = CALL_STATES.EXECUTE_AGREEMENT;
    result.toolAction = CALL_ACTIONS.CALL_CREATE_PAYMENT_AGREEMENT;
    result.speakBack = "Understood. I'll create your payment agreement now.";
    result.intentLabel = "agreement_ready_to_execute";
    result.flags.commitAgreementProposal = true;
    return result;
  }

  result.nextState = CALL_STATES.CLOSE;
  result.toolAction = CALL_ACTIONS.END_CALL;
  result.speakBack = buildClosingMessage({ tenantName, facts });
  result.intentLabel = "close";
  return result;
};
