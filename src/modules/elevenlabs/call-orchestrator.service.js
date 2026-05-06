import {
  CaseAutomationState,
  CollectionEvent,
  DebtCase,
  Debtor,
  FlowPolicy,
  InteractionLog,
  Tenant,
} from "../../models/index.js";
import { resolvePolicyForCase } from "../collections/policy-resolver.service.js";
import { logger } from "../../utils/logger.js";
import {
  CALL_ACTIONS,
  CALL_STATES,
  getAllowedTransitions,
  isAllowedTransition,
  normalizeCallState,
} from "./call-state-machine.js";
import {
  classifyCallAction,
} from "./nlu/action-classifier.service.js";
import { extractSlotPatch } from "./nlu/slot-extractor.service.js";
import {
  DEFAULT_CALL_SLOTS,
  applyAgreementDefaults,
  buildAgreementProposalFromSlots,
  buildDisputeProposalFromSlots,
  countSlotOverwrites,
  deriveSlotPatchFromAction,
  hasMeaningfulProposal,
  mergeCallSlots,
  proposalsAreEqual,
  sanitizeCallSlots,
} from "./dialog/slot-manager.service.js";
import { reduceCallState } from "./dialog/call-reducer.service.js";
import { getPlanCatalogFromResolvedPolicy } from "./policy/plan-catalog.service.js";
import {
  computeFirstPaymentWindowFromPolicyRules,
  NEGOTIATION_CALENDAR_TZ,
  sanitizeFirstDueDateSlot,
  validateFirstDueAgainstWindow,
} from "./negotiation-first-payment-window.service.js";

const ACTION_CONFIDENCE_THRESHOLD =
  Number(process.env.CALL_ACTION_CONFIDENCE_THRESHOLD) || 0.6;
const MAX_STATE_STACK_DEPTH =
  Math.max(1, Number(process.env.CALL_STATE_STACK_MAX_DEPTH) || 1);

const DEFAULT_TELEMETRY = Object.freeze({
  transition_count: 0,
  loop_count: 0,
  invalid_transition_count: 0,
  slot_overwrite_count: 0,
  low_confidence_count: 0,
  fallback_llm_count: 0,
  tool_mismatch_count: 0,
  interruption_count: 0,
  llm_transition_proposed_count: 0,
  llm_transition_accepted_count: 0,
  llm_transition_rejected_count: 0,
  avg_nlu_confidence: 0,
  loop_rate: 0,
  slot_overwrite_rate: 0,
  fallback_llm_rate: 0,
  tool_mismatch_rate: 0,
});

const POST_TOOL_CONFIRM_STATES = new Set([
  CALL_STATES.POST_DELIVERY_CONFIRM,
  CALL_STATES.POST_DISPUTE_CONFIRM,
]);

const INTERRUPTION_TRIGGER_ACTIONS = new Set([
  "ASK_BALANCE",
  "ASK_OPTIONS",
  "ASK_PLAN_SUMMARY",
  "ASK_LINK_DESTINATION",
  "ASK_LINK_CHANNEL",
]);

const normalizeStackAction = (value) => {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (["PUSH", "POP", "NONE"].includes(normalized)) return normalized;
  return "NONE";
};

const normalizeStateStack = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((frame) => {
      if (!frame || typeof frame !== "object") return null;
      const returnState = normalizeCallState(frame.return_state);
      if (!returnState) return null;
      return {
        return_state: returnState,
        interruption_topic:
          String(frame.interruption_topic || "").trim() || null,
        entered_at: String(frame.entered_at || "").trim() || null,
        source: String(frame.source || "").trim() || null,
      };
    })
    .filter(Boolean)
    .slice(-MAX_STATE_STACK_DEPTH);
};

const getTopStateFrame = (stack = []) =>
  Array.isArray(stack) && stack.length > 0 ? stack[stack.length - 1] : null;

const deriveInterruptionTopicFromAction = (action) => {
  switch (action) {
    case "ASK_BALANCE":
      return "BALANCE";
    case "ASK_OPTIONS":
      return "OPTIONS";
    case "ASK_PLAN_SUMMARY":
      return "PLAN_SUMMARY";
    case "ASK_LINK_DESTINATION":
      return "LINK_DESTINATION";
    case "ASK_LINK_CHANNEL":
      return "LINK_CHANNEL";
    case "CONFIRM_LINK_RECEIPT":
      return "LINK_RECEIPT";
    case "REPORT_LINK_NOT_RECEIVED":
      return "LINK_NOT_RECEIVED";
    default:
      return "GENERAL";
  }
};

const resolveTransitionProposal = (entities = {}) => {
  if (!entities || typeof entities !== "object") {
    return {
      proposedNextState: null,
      stackAction: "NONE",
      interruptionTopic: null,
    };
  }

  const proposedNextState = normalizeCallState(
    entities.proposed_next_state ??
      entities.proposedNextState ??
      entities.llm_proposed_next_state ??
      entities.llmProposedNextState ??
      null,
  );

  return {
    proposedNextState,
    stackAction: normalizeStackAction(
      entities.stack_action ??
        entities.stackAction ??
        entities.llm_stack_action ??
        entities.llmStackAction,
    ),
    interruptionTopic:
      String(
        entities.interruption_topic ??
          entities.interruptionTopic ??
          entities.llm_interruption_topic ??
          entities.llmInterruptionTopic ??
          "",
      ).trim() || null,
  };
};

const resolveAllowedToolsForState = (state) => {
  switch (state) {
    case CALL_STATES.CONFIRM_AGREEMENT:
    case CALL_STATES.EXECUTE_AGREEMENT:
      return ["create-payment-agreement"];
    case CALL_STATES.DISPUTE_CAPTURE:
    case CALL_STATES.EXECUTE_DISPUTE:
      return ["create-dispute"];
    default:
      return [];
  }
};

const normalizeText = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const toRate = (count, total) => {
  if (!total || total <= 0) return 0;
  const numeric = Number(count) / Number(total);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(4)) : 0;
};

const resolveInteraction = async ({ tenantId, caseId, interactionId }) => {
  if (interactionId) {
    const byId = await InteractionLog.findOne({
      where: {
        id: interactionId,
        tenantId,
        debtCaseId: caseId,
        type: "CALL",
      },
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
    if (byId) return byId;
  }

  return InteractionLog.findOne({
    where: {
      tenantId,
      debtCaseId: caseId,
      type: "CALL",
    },
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
    order: [["createdAt", "DESC"]],
  });
};

const resolveAutomationIdForCase = async ({ debtCaseId }) => {
  const state = await CaseAutomationState.findOne({
    where: { debtCaseId, status: "active" },
    order: [["updatedAt", "DESC"]],
  });
  return state?.automationId || null;
};

const createCallFsmEvent = async ({ automationId, debtCaseId, payload }) => {
  if (!automationId) return null;
  return CollectionEvent.create({
    automationId,
    debtCaseId,
    channel: "call",
    eventType: "call_fsm_transition",
    payload,
  });
};

const resolveStateFromInteraction = (interaction, requestedState) => {
  const persisted =
    interaction?.aiData?.eleven?.call_state?.state ||
    interaction?.aiData?.call_state?.state ||
    null;
  const persistedState = normalizeCallState(persisted);
  const requested = normalizeCallState(requestedState);

  // Persisted interaction state is source of truth.
  if (persistedState) return persistedState;
  if (requested) return requested;
  return CALL_STATES.VERIFY_IDENTITY;
};

const resolveDeliveryChannelsForDebtor = (debtor) => {
  const hasEmail = Boolean(
    String(debtor?.email || "").trim() &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(debtor?.email || "").trim()),
  );
  const hasPhone = Boolean(String(debtor?.phone || "").trim());
  if (hasEmail && hasPhone) return ["email", "sms", "both"];
  if (hasEmail) return ["email"];
  if (hasPhone) return ["sms"];
  return [];
};

const resolvePreviousCallState = (interaction) => {
  const callState = interaction?.aiData?.eleven?.call_state || {};
  const previousSlots =
    callState?.slots && typeof callState.slots === "object"
      ? callState.slots
      : {};
  const previousFacts =
    callState?.facts && typeof callState.facts === "object"
      ? callState.facts
      : {};
  const previousStateStack = normalizeStateStack(callState?.state_stack);
  const topFrame = getTopStateFrame(previousStateStack);
  const previousTelemetry =
    callState?.telemetry && typeof callState.telemetry === "object"
      ? callState.telemetry
      : {};
  const previousProposalSnapshot =
    callState?.proposal_snapshot &&
    typeof callState.proposal_snapshot === "object"
      ? callState.proposal_snapshot
      : {};
  const previousProposalCommitted =
    callState?.proposal_committed &&
    typeof callState.proposal_committed === "object"
      ? callState.proposal_committed
      : {};

  return {
    callState,
    previousSlots: { ...DEFAULT_CALL_SLOTS, ...previousSlots },
    previousFacts,
    previousStateStack,
    previousReturnState:
      normalizeCallState(callState?.return_state) ||
      normalizeCallState(topFrame?.return_state) ||
      null,
    previousInterruptionTopic:
      String(callState?.interruption_topic || topFrame?.interruption_topic || "")
        .trim() || null,
    previousTelemetry: { ...DEFAULT_TELEMETRY, ...previousTelemetry },
    previousProposalSnapshot,
    previousProposalCommitted,
  };
};

const updateProposalSnapshots = ({
  nowIso,
  previousProposalSnapshot,
  previousProposalCommitted,
  agreementDraft,
  disputeDraft,
  reducer,
  slots,
}) => {
  let proposalSnapshot = {
    agreement: previousProposalSnapshot?.agreement || null,
    dispute: previousProposalSnapshot?.dispute || null,
    version: Number(previousProposalSnapshot?.version || 0),
    updated_at: previousProposalSnapshot?.updated_at || null,
  };

  if (
    hasMeaningfulProposal(disputeDraft) &&
    !proposalsAreEqual(proposalSnapshot.dispute, disputeDraft)
  ) {
    proposalSnapshot = {
      ...proposalSnapshot,
      dispute: disputeDraft,
      version: proposalSnapshot.version + 1,
      updated_at: nowIso,
    };
  }

  if (
    reducer?.flags?.requestAgreementSnapshot &&
    hasMeaningfulProposal(agreementDraft) &&
    !proposalsAreEqual(proposalSnapshot.agreement, agreementDraft)
  ) {
    proposalSnapshot = {
      ...proposalSnapshot,
      agreement: agreementDraft,
      version: proposalSnapshot.version + 1,
      updated_at: nowIso,
    };
  }

  if (reducer?.flags?.resetAgreementFields) {
    proposalSnapshot = {
      ...proposalSnapshot,
      agreement: null,
      version: proposalSnapshot.version + 1,
      updated_at: nowIso,
    };
  }

  let proposalCommitted = {
    agreement: previousProposalCommitted?.agreement || null,
    dispute: previousProposalCommitted?.dispute || null,
    version: Number(previousProposalCommitted?.version || 0),
    committed_at: previousProposalCommitted?.committed_at || null,
    source: previousProposalCommitted?.source || null,
  };

  if (reducer?.flags?.commitAgreementProposal) {
    const agreementToCommit =
      proposalSnapshot.agreement || agreementDraft || null;
    if (
      hasMeaningfulProposal(agreementToCommit) &&
      !proposalsAreEqual(proposalCommitted.agreement, agreementToCommit)
    ) {
      proposalCommitted = {
        ...proposalCommitted,
        agreement: agreementToCommit,
        version: proposalCommitted.version + 1,
        committed_at: nowIso,
        source: "orchestrator",
      };
    }
  }

  if (reducer?.flags?.commitDisputeProposal) {
    const disputeToCommit = proposalSnapshot.dispute || disputeDraft || null;
    if (
      hasMeaningfulProposal(disputeToCommit) &&
      !proposalsAreEqual(proposalCommitted.dispute, disputeToCommit)
    ) {
      proposalCommitted = {
        ...proposalCommitted,
        dispute: disputeToCommit,
        version: proposalCommitted.version + 1,
        committed_at: nowIso,
        source: "orchestrator",
      };
    }
  }

  if (slots?.dispute_detected !== true && proposalSnapshot.dispute) {
    proposalSnapshot = {
      ...proposalSnapshot,
      dispute: null,
      version: proposalSnapshot.version + 1,
      updated_at: nowIso,
    };
  }

  return { proposalSnapshot, proposalCommitted };
};

const computeTelemetry = ({
  previousTelemetry,
  actionDecision,
  slotOverwrites,
  stateBefore,
  stateAfter,
  invalidTransition,
  toolAction,
  reducer,
  enteredInterruption,
  llmProposal,
  llmTransitionAccepted,
  llmTransitionRejected,
}) => {
  const transitionCount = Number(previousTelemetry.transition_count || 0) + 1;
  const loopCount =
    Number(previousTelemetry.loop_count || 0) +
    (stateBefore === stateAfter ? 1 : 0);
  const invalidTransitionCount =
    Number(previousTelemetry.invalid_transition_count || 0) +
    (invalidTransition ? 1 : 0);
  const slotOverwriteCount =
    Number(previousTelemetry.slot_overwrite_count || 0) +
    Number(slotOverwrites || 0);
  const lowConfidenceCount =
    Number(previousTelemetry.low_confidence_count || 0) +
    (Number(actionDecision?.confidence || 0) < ACTION_CONFIDENCE_THRESHOLD
      ? 1
      : 0);
  const fallbackLlmCount =
    Number(previousTelemetry.fallback_llm_count || 0) +
    (actionDecision?.source === "llm_fallback" ? 1 : 0);

  const hasToolMismatch =
    reducer?.flags?.toolMismatch ||
    Boolean(
      invalidTransition &&
        reducer?.toolAction &&
        reducer.toolAction !== CALL_ACTIONS.NONE,
    );
  const toolMismatchCount =
    Number(previousTelemetry.tool_mismatch_count || 0) +
    (hasToolMismatch ? 1 : 0);
  const interruptionCount =
    Number(previousTelemetry.interruption_count || 0) +
    (enteredInterruption ? 1 : 0);
  const llmTransitionProposedCount =
    Number(previousTelemetry.llm_transition_proposed_count || 0) +
    (llmProposal?.proposedNextState ? 1 : 0);
  const llmTransitionAcceptedCount =
    Number(previousTelemetry.llm_transition_accepted_count || 0) +
    (llmTransitionAccepted ? 1 : 0);
  const llmTransitionRejectedCount =
    Number(previousTelemetry.llm_transition_rejected_count || 0) +
    (llmTransitionRejected ? 1 : 0);

  const previousTransitions = Number(previousTelemetry.transition_count || 0);
  const previousAverage = Number(previousTelemetry.avg_nlu_confidence || 0);
  const avgNluConfidence =
    (previousAverage * previousTransitions +
      Number(actionDecision?.confidence || 0)) /
    transitionCount;

  return {
    transition_count: transitionCount,
    loop_count: loopCount,
    invalid_transition_count: invalidTransitionCount,
    slot_overwrite_count: slotOverwriteCount,
    low_confidence_count: lowConfidenceCount,
    fallback_llm_count: fallbackLlmCount,
    tool_mismatch_count: toolMismatchCount,
    interruption_count: interruptionCount,
    llm_transition_proposed_count: llmTransitionProposedCount,
    llm_transition_accepted_count: llmTransitionAcceptedCount,
    llm_transition_rejected_count: llmTransitionRejectedCount,
    avg_nlu_confidence: Number(avgNluConfidence.toFixed(4)),
    loop_rate: toRate(loopCount, transitionCount),
    slot_overwrite_rate: toRate(slotOverwriteCount, transitionCount),
    fallback_llm_rate: toRate(fallbackLlmCount, transitionCount),
    tool_mismatch_rate: toRate(toolMismatchCount, transitionCount),
  };
};

const buildPolicyResponse = ({
  planCatalog,
  resolvedPolicy,
  allowedDeliveryChannels,
}) => {
  const allowedPaymentChannels = Array.isArray(
    resolvedPolicy?.rules?.payment_channels,
  )
    ? resolvedPolicy.rules.payment_channels
        .map((item) =>
          String(item || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean)
    : [];

  return {
    stage_name: String(resolvedPolicy?.stage?.name || "").trim() || null,
    stage_tone:
      String(resolvedPolicy?.stage?.tone || "").trim() ||
      String(resolvedPolicy?.tone || "").trim() ||
      null,
    allowed_plan_types: planCatalog.allowedPlanTypes,
    allowed_payment_channels: allowedPaymentChannels,
    allowed_delivery_channels: allowedDeliveryChannels,
    max_installments: planCatalog.maxInstallments,
    min_upfront_pct: planCatalog.minUpfrontPct,
    half_pct: planCatalog.halfPct,
  };
};

export const orchestrateCallStepFromTool = async ({
  tenantId,
  caseId,
  interactionId,
  currentState,
  userUtterance,
  intentHint,
  entities,
}) => {
  const [interaction, tenant] = await Promise.all([
    resolveInteraction({ tenantId, caseId, interactionId }),
    Tenant.findByPk(tenantId, { attributes: ["name"] }),
  ]);
  if (!interaction) {
    return {
      ok: false,
      code: "INTERACTION_NOT_FOUND",
      message: "Call interaction context was not found.",
    };
  }

  const debtCase = interaction.debtCase;
  const debtor = debtCase?.debtor;
  if (!debtCase || !debtor) {
    return {
      ok: false,
      code: "CASE_CONTEXT_NOT_FOUND",
      message: "Debt case or debtor context missing for orchestration.",
    };
  }

  const tenantName = String(
    debtCase?.meta?.tenant_display_name ||
      debtCase?.meta?.tenant_name ||
      tenant?.name ||
      "collections team",
  ).trim();

  const resolvedPolicy = await resolvePolicyForCase(tenantId, debtCase);
  const planCatalog = getPlanCatalogFromResolvedPolicy(resolvedPolicy);
  const allowedDeliveryChannels = resolveDeliveryChannelsForDebtor(debtor);
  const normalizedState = resolveStateFromInteraction(
    interaction,
    currentState,
  );

  const {
    callState: previousCallState,
    previousSlots,
    previousFacts,
    previousStateStack,
    previousReturnState,
    previousInterruptionTopic,
    previousTelemetry,
    previousProposalSnapshot,
    previousProposalCommitted,
  } = resolvePreviousCallState(interaction);

  const transitionProposal = resolveTransitionProposal(entities);
  const actionClassificationState =
    normalizedState === CALL_STATES.INTERRUPTION && previousReturnState
      ? previousReturnState
      : normalizedState;

  const actionDecision = classifyCallAction({
    state: actionClassificationState,
    intentHint,
    entities,
    utterance: userUtterance,
  });

  const slotPatchFromExtractor = extractSlotPatch({
    entities,
    utterance: userUtterance,
    currentState: actionClassificationState,
    allowedPlanTypes: planCatalog.allowedPlanTypes,
    allowedDeliveryChannels,
  });
  const slotPatchFromAction = deriveSlotPatchFromAction(actionDecision.action);

  let mergedSlots = mergeCallSlots({
    previousSlots,
    patch: { ...slotPatchFromExtractor, ...slotPatchFromAction },
  });
  mergedSlots = sanitizeCallSlots({ slots: mergedSlots });
  mergedSlots = applyAgreementDefaults({
    slots: mergedSlots,
    planCatalog,
    balanceCents: Number(debtCase.amountDueCents || 0),
    allowedDeliveryChannels,
  });

  const firstPaymentWindow = computeFirstPaymentWindowFromPolicyRules(
    resolvedPolicy?.rules || {},
    NEGOTIATION_CALENDAR_TZ,
  );
  const dueSanitized = sanitizeFirstDueDateSlot(
    mergedSlots,
    firstPaymentWindow,
  );
  mergedSlots = dueSanitized.slots;
  if (dueSanitized.rejected) {
    mergedSlots = { ...mergedSlots, agreement_confirmed: null };
  }
  const firstDueRejected = dueSanitized.rejected
    ? { reason: dueSanitized.reason || "invalid_format" }
    : null;

  const dueStr =
    mergedSlots.first_due_date != null
      ? String(mergedSlots.first_due_date).trim().slice(0, 10)
      : "";
  const dueOk = firstPaymentWindow
    ? validateFirstDueAgainstWindow(dueStr, firstPaymentWindow).ok
    : Boolean(dueStr && /^\d{4}-\d{2}-\d{2}$/.test(dueStr));
  if (!dueOk) {
    mergedSlots = { ...mergedSlots, agreement_confirmed: null };
  }

  const isQuestionAction = INTERRUPTION_TRIGGER_ACTIONS.has(
    actionDecision.action,
  );
  const llmRequestedInterruption =
    transitionProposal.proposedNextState === CALL_STATES.INTERRUPTION &&
    transitionProposal.stackAction !== "POP";
  const shouldResumeFromInterruption =
    normalizedState === CALL_STATES.INTERRUPTION &&
    Boolean(previousReturnState) &&
    !isQuestionAction &&
    transitionProposal.proposedNextState !== CALL_STATES.INTERRUPTION &&
    transitionProposal.stackAction !== "PUSH";

  let reducerState = normalizedState;
  let stateStack = [...previousStateStack];
  let returnState = previousReturnState || null;
  let interruptionTopic = previousInterruptionTopic || null;
  let enteredInterruption = false;
  let resumedFromInterruption = false;
  let llmTransitionAccepted = false;
  let llmTransitionRejected = false;

  if (shouldResumeFromInterruption) {
    reducerState = previousReturnState;
    stateStack = stateStack.slice(0, -1);
    const nextTopFrame = getTopStateFrame(stateStack);
    returnState = normalizeCallState(nextTopFrame?.return_state) || null;
    interruptionTopic =
      String(nextTopFrame?.interruption_topic || "").trim() || null;
    resumedFromInterruption = true;
  } else {
    const canEnterInterruption =
      normalizedState !== CALL_STATES.CLOSE &&
      normalizedState !== CALL_STATES.INTERRUPTION &&
      stateStack.length < MAX_STATE_STACK_DEPTH &&
      (llmRequestedInterruption ||
        (isQuestionAction && !POST_TOOL_CONFIRM_STATES.has(normalizedState)));

    if (canEnterInterruption) {
      const frame = {
        return_state: normalizedState,
        interruption_topic:
          transitionProposal.interruptionTopic ||
          deriveInterruptionTopicFromAction(actionDecision.action),
        entered_at: new Date().toISOString(),
        source: llmRequestedInterruption ? "llm_proposal" : "auto",
      };
      stateStack = [...stateStack, frame].slice(-MAX_STATE_STACK_DEPTH);
      returnState = frame.return_state;
      interruptionTopic = frame.interruption_topic;
      reducerState = CALL_STATES.INTERRUPTION;
      enteredInterruption = true;
      llmTransitionAccepted = llmRequestedInterruption;
    } else if (llmRequestedInterruption) {
      llmTransitionRejected = true;
    }
  }

  const reducer = reduceCallState({
    state: reducerState,
    action: actionDecision.action,
    slots: mergedSlots,
    previousSlots,
    context: {
      debtorName: debtor.fullName || "the account holder",
      tenantName,
      balanceCents: Number(debtCase.amountDueCents || 0),
      currency: debtCase.currency || "USD",
      planCatalog,
      allowedDeliveryChannels,
      facts: previousFacts,
      returnState,
      interruptionTopic,
      stateStack,
      firstPaymentWindow,
      firstDueRejected,
    },
  });

  if (reducer?.flags?.resetAgreementFields) {
    mergedSlots = sanitizeCallSlots({
      slots: {
        ...mergedSlots,
        plan_type: null,
        upfront_amount_cents: null,
        installments_count: null,
        delivery_channel: null,
        first_due_date: null,
        agreement_confirmed: null,
      },
    });
  }

  const proposedNextState = reducer.nextState;
  const invalidTransition = !isAllowedTransition(
    reducerState,
    proposedNextState,
  );
  const nextState = invalidTransition ? reducerState : proposedNextState;
  const toolAction = invalidTransition ? CALL_ACTIONS.NONE : reducer.toolAction;
  const shouldClose = nextState === CALL_STATES.CLOSE;
  const nowIso = new Date().toISOString();

  const agreementDraft = hasMeaningfulProposal(
    buildAgreementProposalFromSlots(mergedSlots),
  )
    ? buildAgreementProposalFromSlots(mergedSlots)
    : null;
  const disputeDraft = hasMeaningfulProposal(
    buildDisputeProposalFromSlots(mergedSlots),
  )
    ? buildDisputeProposalFromSlots(mergedSlots)
    : null;
  const proposalDrafts = {
    agreement: agreementDraft,
    dispute: disputeDraft,
    updated_at: nowIso,
  };

  const { proposalSnapshot, proposalCommitted } = updateProposalSnapshots({
    nowIso,
    previousProposalSnapshot,
    previousProposalCommitted,
    agreementDraft,
    disputeDraft,
    reducer,
    slots: mergedSlots,
  });

  const slotOverwrites = countSlotOverwrites({
    previousSlots,
    nextSlots: mergedSlots,
  });

  const telemetry = computeTelemetry({
    previousTelemetry,
    actionDecision,
    slotOverwrites,
    stateBefore: reducerState,
    stateAfter: nextState,
    invalidTransition,
    toolAction,
    reducer,
    enteredInterruption,
    llmProposal: transitionProposal,
    llmTransitionAccepted,
    llmTransitionRejected,
  });

  const nextFacts = {
    ...previousFacts,
  };

  if (reducer.intentLabel === "callback_requested") {
    nextFacts.closing_context = "callback_requested";
  }

  const persistedStateStack = shouldClose ? [] : stateStack;
  const topFrame = getTopStateFrame(persistedStateStack);
  const persistedReturnState = shouldClose
    ? null
    : normalizeCallState(topFrame?.return_state) || returnState || null;
  const persistedInterruptionTopic = shouldClose
    ? null
    : String(topFrame?.interruption_topic || interruptionTopic || "").trim() ||
      null;

  await interaction.update({
    aiData: {
      ...(interaction.aiData || {}),
      eleven: {
        ...(interaction.aiData?.eleven || {}),
        call_state: {
          ...previousCallState,
          state: nextState,
          previous_state: normalizedState,
          last_intent: reducer.intentLabel,
          last_action: toolAction,
          last_user_utterance: normalizeText(userUtterance),
          slots: mergedSlots,
          entities: {
            ...(entities && typeof entities === "object" ? entities : {}),
            ...slotPatchFromExtractor,
            ...slotPatchFromAction,
          },
          nlu: {
            action: actionDecision.action,
            confidence: Number(actionDecision.confidence || 0),
            source: actionDecision.source || "none",
            threshold: ACTION_CONFIDENCE_THRESHOLD,
            intent_hint: String(intentHint || "").trim() || null,
          },
          proposal_drafts: proposalDrafts,
          proposal_snapshot: proposalSnapshot,
          proposal_committed: proposalCommitted,
          facts: nextFacts,
          state_stack: persistedStateStack,
          return_state: persistedReturnState,
          interruption_topic: persistedInterruptionTopic,
          telemetry,
          transition_count: telemetry.transition_count,
          updated_at: nowIso,
        },
      },
    },
  });

  const resolvedAutomationId = await resolveAutomationIdForCase({
    debtCaseId: debtCase.id,
  });
  await createCallFsmEvent({
    automationId: resolvedAutomationId,
    debtCaseId: debtCase.id,
    payload: {
      interaction_id: interaction.id,
      state_before: normalizedState,
      reducer_state: reducerState,
      state_after: nextState,
      dialog_action: actionDecision.action,
      dialog_action_confidence: Number(actionDecision.confidence || 0),
      dialog_action_source: actionDecision.source || "none",
      intent: reducer.intentLabel,
      action: toolAction,
      should_close: shouldClose,
      invalid_transition_blocked: invalidTransition,
      interruption_entered: enteredInterruption,
      interruption_resumed: resumedFromInterruption,
      state_stack_depth: persistedStateStack.length,
      llm_transition_proposed: transitionProposal.proposedNextState || null,
      llm_transition_accepted: llmTransitionAccepted,
      llm_transition_rejected: llmTransitionRejected,
      telemetry: {
        transition_count: telemetry.transition_count,
        loop_rate: telemetry.loop_rate,
        slot_overwrite_rate: telemetry.slot_overwrite_rate,
        fallback_llm_rate: telemetry.fallback_llm_rate,
        tool_mismatch_rate: telemetry.tool_mismatch_rate,
        avg_nlu_confidence: telemetry.avg_nlu_confidence,
      },
    },
  });

  logger.info(
    {
      interactionId: interaction.id,
      debtCaseId: debtCase.id,
      stateBefore: normalizedState,
      reducerState,
      stateAfter: nextState,
      dialogAction: actionDecision.action,
      dialogActionConfidence: actionDecision.confidence,
      toolAction,
      shouldClose,
      invalidTransition,
      enteredInterruption,
      resumedFromInterruption,
      stateStackDepth: persistedStateStack.length,
      llmTransitionProposed: transitionProposal.proposedNextState,
      llmTransitionAccepted,
      llmTransitionRejected,
    },
    "ElevenLabs call FSM step orchestrated",
  );

  return {
    ok: true,
    interaction_id: interaction.id,
    current_state: normalizedState,
    reducer_state: reducerState,
    next_state: nextState,
    state_changed: normalizedState !== nextState,
    dialog_action: actionDecision.action,
    dialog_action_confidence: Number(actionDecision.confidence || 0),
    dialog_action_source: actionDecision.source || "none",
    intent: reducer.intentLabel,
    action: toolAction,
    should_close: shouldClose,
    speak_back: reducer.speakBack,
    allowed_transitions: getAllowedTransitions(nextState),
    entities: mergedSlots,
    slots: mergedSlots,
    proposal_drafts: proposalDrafts,
    proposal_snapshot: proposalSnapshot,
    proposal_committed: proposalCommitted,
    facts: nextFacts,
    state_stack: persistedStateStack,
    return_state: persistedReturnState,
    interruption_topic: persistedInterruptionTopic,
    allowed_tools: resolveAllowedToolsForState(nextState),
    llm_transition: {
      proposed_next_state: transitionProposal.proposedNextState || null,
      stack_action: transitionProposal.stackAction,
      interruption_topic: transitionProposal.interruptionTopic,
      accepted: llmTransitionAccepted,
      rejected: llmTransitionRejected,
    },
    telemetry,
    policy: buildPolicyResponse({
      planCatalog,
      resolvedPolicy,
      allowedDeliveryChannels,
    }),
  };
};
