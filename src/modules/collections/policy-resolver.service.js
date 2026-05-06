/**
 * Policy resolver (adapter) for Collections Engine v1 vs v2.
 * Returns a single "policy-like" shape { channels, tone, rules } so the worker
 * does not need to know whether the tenant uses FlowPolicy (v1) or Strategy+Stage (v2).
 */
import {
  Tenant,
  FlowPolicy,
  CollectionStrategy,
  CollectionStage,
  CollectionAutomation,
  CaseAutomationState,
} from '../../models/index.js';

const DEFAULT_POLICY = {
  channels: { sms: false, email: false, call: false, whatsapp: false },
  tone: 'professional',
  rules: {},
  stage: null,
};

/** System default rules when none are set (contract: channels, tone, rules). */
const SYSTEM_DEFAULT_RULES = {
  allowed_plans: ['FULL', 'HALF', 'INSTALLMENTS'],
  min_upfront_pct: 25,
  half_pct: 50,
  max_installments: 4,
  custom_instructions: '',
  payment_channels: ['link', 'card'],
  opening_message: '',
  tenant_display_name: '',
};

/**
 * Normalize raw rules (from FlowPolicy or Strategy/Stage) to the standard contract.
 * Fills missing fields with system defaults.
 * @param {object} raw - Raw rules (may use snake_case or camelCase)
 * @returns {object} Normalized rules: allowed_plans, min_upfront_pct, half_pct, max_installments, optional min_installments, require_down_payment
 */
function normalizeRules(raw) {
  if (!raw || typeof raw !== 'object') return { ...SYSTEM_DEFAULT_RULES };
  const allowed = raw.allowed_plans ?? raw.allowedPlans;
  const allowedArr = Array.isArray(allowed)
    ? allowed.map((p) => String(p).toUpperCase())
    : SYSTEM_DEFAULT_RULES.allowed_plans;
  // Normalize INSTALLMENTS -> INSTALLMENTS for contract; agent may map to INSTALLMENTS_4 internally
  const allowedPlans = allowedArr.filter(Boolean);
  const customInstructions = raw.custom_instructions ?? raw.customInstructions ?? '';
  const openingMessage = raw.opening_message ?? raw.openingMessage ?? '';
  const tenantDisplayName =
    raw.tenant_display_name ?? raw.tenantDisplayName ?? raw.tenant_name ?? '';
  const paymentChannelsRaw = raw.payment_channels ?? raw.paymentChannels;
  const paymentChannels = Array.isArray(paymentChannelsRaw)
    ? paymentChannelsRaw.map((c) => String(c).toLowerCase()).filter(Boolean)
    : SYSTEM_DEFAULT_RULES.payment_channels;

  /** Max calendar days from "today" (tenant TZ via AGREEMENT_INSTALLMENT_CALENDAR_TZ on read) for first payment / first installment date. */
  const maxDaysRaw =
    raw.negotiation_first_payment_max_days ?? raw.negotiationFirstPaymentMaxDays ?? null;
  const negotiationFirstPaymentMaxDays =
    maxDaysRaw != null && maxDaysRaw !== '' && Number.isFinite(Number(maxDaysRaw))
      ? Math.max(0, Math.trunc(Number(maxDaysRaw)))
      : undefined;

  const deadlineRaw =
    raw.negotiation_first_payment_deadline ?? raw.negotiationFirstPaymentDeadline ?? null;
  let negotiationFirstPaymentDeadline;
  if (deadlineRaw) {
    const d = new Date(deadlineRaw);
    negotiationFirstPaymentDeadline = Number.isNaN(d.getTime())
      ? undefined
      : d.toISOString().slice(0, 10);
  }

  const capLastWdRaw =
    raw.negotiation_first_payment_cap_last_weekday_of_month ??
    raw.negotiationFirstPaymentCapLastWeekdayOfMonth;
  const negotiationCapLastWeekdayOfMonth =
    capLastWdRaw === true ||
    capLastWdRaw === 1 ||
    capLastWdRaw === '1' ||
    String(capLastWdRaw || '').toLowerCase() === 'true';

  return {
    allowed_plans: allowedPlans.length ? allowedPlans : SYSTEM_DEFAULT_RULES.allowed_plans,
    min_upfront_pct: Number(raw.min_upfront_pct ?? raw.minUpfrontPct ?? SYSTEM_DEFAULT_RULES.min_upfront_pct),
    half_pct: Number(raw.half_pct ?? raw.halfPct ?? SYSTEM_DEFAULT_RULES.half_pct),
    max_installments: Number(raw.max_installments ?? raw.maxInstallments ?? SYSTEM_DEFAULT_RULES.max_installments),
    min_installments: raw.min_installments != null ? Number(raw.min_installments) : undefined,
    require_down_payment: raw.require_down_payment ?? raw.requireDownPayment,
    custom_instructions: typeof customInstructions === 'string' ? customInstructions : '',
    opening_message: typeof openingMessage === 'string' ? openingMessage : '',
    tenant_display_name: typeof tenantDisplayName === 'string' ? tenantDisplayName : '',
    payment_channels: paymentChannels.length ? paymentChannels : SYSTEM_DEFAULT_RULES.payment_channels,
    ...(negotiationFirstPaymentMaxDays !== undefined
      ? { negotiation_first_payment_max_days: negotiationFirstPaymentMaxDays }
      : {}),
    ...(negotiationFirstPaymentDeadline ? { negotiation_first_payment_deadline: negotiationFirstPaymentDeadline } : {}),
    ...(negotiationCapLastWeekdayOfMonth
      ? { negotiation_first_payment_cap_last_weekday_of_month: true }
      : {}),
  };
}

function selectStageByDaysPastDue(stages, daysPastDue) {
  const sorted = [...stages].sort((a, b) => a.minDaysPastDue - b.minDaysPastDue);
  return sorted.find((s) => {
    const minOk = daysPastDue >= s.minDaysPastDue;
    const maxOk = s.maxDaysPastDue == null || daysPastDue <= s.maxDaysPastDue;
    return minOk && maxOk;
  });
}

/**
 * Resolve policy for a debt case. Used by the worker to get channels, tone, rules
 * without caring if tenant is on v1 (FlowPolicy) or v2 (Strategy + Stage).
 *
 * @param {string} tenantId
 * @param {object} debtCase - DebtCase instance or plain with id, flowPolicyId, daysPastDue
 * @returns {Promise<{ channels: object, tone: string, rules: object }>}
 */
export async function resolvePolicyForCase(tenantId, debtCase) {
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'collectionsEngineVersion'] });
  if (!tenant) return DEFAULT_POLICY;

  const version = tenant.collectionsEngineVersion || 'v1';

  if (version === 'v1') {
    const flowPolicyId = debtCase.flowPolicyId ?? debtCase.flow_policy_id;
    if (!flowPolicyId) return DEFAULT_POLICY;
    const policy = await FlowPolicy.findByPk(flowPolicyId, {
      attributes: ['channels', 'tone', 'rules'],
    });
    if (!policy) return DEFAULT_POLICY;
    const plain = policy.get ? policy.get({ plain: true }) : policy;
    return {
      channels: plain.channels ?? DEFAULT_POLICY.channels,
      tone: plain.tone ?? DEFAULT_POLICY.tone,
      rules: normalizeRules(plain.rules),
      stage: null,
    };
  }

  // v2: find active case_automation_state for this debt_case -> automation -> strategy + stages
  const debtCaseId = debtCase.id ?? debtCase.debt_case_id;
  const daysPastDue = debtCase.daysPastDue ?? debtCase.days_past_due ?? 0;

  const state = await CaseAutomationState.findOne({
    where: { debtCaseId, status: 'active' },
    include: [
      {
        model: CollectionAutomation,
        as: 'automation',
        where: { status: 'active' },
        required: true,
        include: [
          {
            model: CollectionStrategy,
            as: 'strategy',
            required: true,
            include: [
              {
                model: CollectionStage,
                as: 'stages',
                where: { isActive: true },
                required: false,
              },
            ],
          },
        ],
      },
    ],
  });

  if (!state?.automation?.strategy) return DEFAULT_POLICY;

  const strategy = state.automation.strategy;
  const stages = strategy.stages ?? [];
  const stage = selectStageByDaysPastDue(stages, daysPastDue);

  if (!stage) return DEFAULT_POLICY;

  const globalRules = strategy.globalRules ?? {};
  const stageRules = stage.rules ?? {};
  const merged = { ...globalRules, ...stageRules };
  return {
    channels: stage.channels ?? DEFAULT_POLICY.channels,
    tone: stage.tone ?? DEFAULT_POLICY.tone,
    rules: normalizeRules(merged),
    stage: {
      id: stage.id,
      name: stage.name,
      minDaysPastDue: stage.minDaysPastDue,
      maxDaysPastDue: stage.maxDaysPastDue,
      tone: stage.tone ?? DEFAULT_POLICY.tone,
      channels: stage.channels ?? DEFAULT_POLICY.channels,
    },
  };
}
