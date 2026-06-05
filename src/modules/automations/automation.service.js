import { Op } from 'sequelize';
import { CaseAutomationState, PmsConnection, DebtCase, Debtor, PmsLease, CaseDispute, CollectionEvent, CollectionStage, InteractionLog } from '../../models/index.js';
import { automationRepository } from './automation.repository.js';
import {
  addCaseActionJob,
  CASE_ACTION_JOB_TYPES,
} from '../../queues/case-actions.queue.js';
import { tenantRepository } from '../tenants/tenant.repository.js';
import { strategyRepository } from '../strategies/strategy.repository.js';
import { resolveChannelTemplate } from '../templates/template-resolution.service.js';
import { NotFoundError, ConflictError } from '../../errors/index.js';
import { logger } from '../../utils/logger.js';
import { resolveApprovalStatus } from '../cases/approval-resolver.service.js';
import { expireStaleCallInteractionsForDebtCase } from '../elevenlabs/eleven.service.js';
import { runSmsCaseDispatch } from '../collections/sms-case-dispatch.runner.js';
import { getBullmqPrefix } from '../../queues/bullmq-queue-options.js';

const ELIGIBLE_STATUSES = ['NEW', 'IN_PROGRESS', 'CONTACTED', 'PROMISE_TO_PAY', 'PAYMENT_PLAN', 'NO_ANSWER', 'REFUSED'];

/** When DB columns are null, recover YYYY-MM-DD from stored tool snapshot (legacy / edge cases). */
function extractFirstDueYmdFromAgreementTerms(terms) {
  if (!terms || typeof terms !== 'object') return null;
  const proposal = terms.proposal ?? terms.payload_proposal;
  if (!proposal || typeof proposal !== 'object') return null;
  const raw = proposal.first_due_date ?? proposal.firstDueDate;
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Small, UI-safe slice of debt_cases.meta (call summaries, etc.). */
function pickDebtCaseMetaHighlights(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const candidates = ['last_call_summary', 'call_summary', 'summary', 'last_summary'];
  for (const k of candidates) {
    const v = meta[k];
    if (typeof v === 'string' && v.trim()) {
      return { summarySnippet: v.trim().slice(0, 500) };
    }
  }
  return null;
}

function summarizeAgreementTermsForUi(terms) {
  if (!terms || typeof terms !== 'object') return null;
  const proposal = terms.proposal ?? terms.payload_proposal ?? {};
  const planType = proposal.plan_type ?? proposal.planType ?? terms.plan_type ?? null;
  const rawDue = proposal.first_due_date ?? proposal.firstDueDate;
  const firstDueStr =
    rawDue != null && rawDue !== '' ? String(rawDue).trim().slice(0, 10) : '';
  return {
    planType: planType != null ? String(planType) : null,
    firstDueDate: /^\d{4}-\d{2}-\d{2}$/.test(firstDueStr) ? firstDueStr : null,
    interactionId: terms.interaction_id ?? terms.interactionId ?? null,
  };
}

const CHANNEL_ORDER = ['call', 'sms', 'email', 'whatsapp'];
const resolveDispatchChannels = (channels = {}) =>
  CHANNEL_ORDER.filter((channel) => channels[channel] === true);
const isStageChannelEnabled = (state, channel) =>
  state?.currentStage?.channels?.[channel] === true;

const resolveMissingTemplateMessage = (channel, reason) => {
  if (reason === 'stage_template_not_found') {
    return `${channel.toUpperCase()} template configured in stage was not found or is inactive`;
  }
  return `${channel.toUpperCase()} template is not configured for this stage`;
};

function selectStageByDaysPastDue(stages, daysPastDue) {
  const active = (stages || []).filter((s) => s.isActive !== false);
  const sorted = [...active].sort((a, b) => a.minDaysPastDue - b.minDaysPastDue);
  if (sorted.length === 0) return null;

  // DPD above the highest defined max (e.g. 202 when Special is 31–150) → last stage
  const stagesWithMax = sorted.filter((s) => s.maxDaysPastDue != null);
  const highestMax = stagesWithMax.length
    ? Math.max(...stagesWithMax.map((s) => Number(s.maxDaysPastDue)))
    : 0;
  if (daysPastDue > highestMax) return sorted[sorted.length - 1];

  // Among stages that match, pick the most specific (largest minDaysPastDue)
  const matching = sorted.filter((s) => {
    const minOk = daysPastDue >= Number(s.minDaysPastDue);
    const maxOk = s.maxDaysPastDue == null || daysPastDue <= Number(s.maxDaysPastDue);
    return minOk && maxOk;
  });
  if (matching.length > 0) return matching[matching.length - 1];

  // DPD before first range (e.g. 0 when first is 1–5) → first stage
  if (daysPastDue < sorted[0].minDaysPastDue) return sorted[0];
  // Fallback → last stage
  return sorted[sorted.length - 1];
}

function startOfToday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export const automationService = {
  list: async (tenantId, pmsConnectionId = null) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    if (pmsConnectionId) {
      return await automationRepository.findByConnection(tenantId, pmsConnectionId);
    }
    return await automationRepository.findByTenant(tenantId);
  },

  getById: async (tenantId, automationId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    return automation;
  },

  update: async (tenantId, automationId, data) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    const updates = {};
    if (data.approvalMode != null) updates.approvalMode = data.approvalMode;
    if (data.approvalRules != null) updates.approvalRules = data.approvalRules;
    await automationRepository.update(automationId, tenantId, updates);
    return automationRepository.findById(automationId, tenantId);
  },

  create: async (tenantId, data) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const connection = await PmsConnection.findOne({ where: { id: data.pmsConnectionId, tenantId } });
    if (!connection) throw new NotFoundError('PMS connection');

    const strategy = await strategyRepository.findById(data.strategyId, tenantId);
    if (!strategy) throw new NotFoundError('Strategy');

    const existing = await automationRepository.findByConnection(tenantId, data.pmsConnectionId);
    const sameStrategy = existing.find((a) => a.strategyId === data.strategyId && a.status !== 'stopped');
    if (sameStrategy) {
      throw new ConflictError('An automation with this strategy is already running (or paused) on this connection');
    }

    const automation = await automationRepository.create({
      tenantId,
      pmsConnectionId: data.pmsConnectionId,
      strategyId: data.strategyId,
      status: 'paused',
      pausedAt: new Date(),
      startedAt: null,
      stats: {},
    });

    // Auto-enroll eligible cases so the Cases tab has data immediately
    try {
      await automationService.enroll(tenantId, automation.id, {});
    } catch (err) {
      logger.warn({ err, automationId: automation.id }, 'Auto-enroll after create failed (e.g. no stages or no eligible cases)');
    }

    return await automationRepository.findById(automation.id, tenantId);
  },

  activate: async (tenantId, automationId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    const updates = {
      status: 'active',
      pausedAt: null,
      nextTickAt: new Date(),
    };
    if (!automation.startedAt) {
      updates.startedAt = new Date();
    }
    await automationRepository.update(automationId, tenantId, updates);
    return await automationRepository.findById(automationId, tenantId);
  },

  pause: async (tenantId, automationId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    await automationRepository.update(automationId, tenantId, {
      status: 'paused',
      pausedAt: new Date(),
    });
    return await automationRepository.findById(automationId, tenantId);
  },

  stop: async (tenantId, automationId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    await automationRepository.update(automationId, tenantId, { status: 'stopped' });
    return await automationRepository.findById(automationId, tenantId);
  },

  delete: async (tenantId, automationId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    await automationRepository.delete(automationId, tenantId);
    return { deleted: true, automationId };
  },

  getOverview: async (tenantId, automationId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const { counts, stages } = await automationRepository.getOverviewData(automationId, tenantId);

    const events = await automationRepository.findEvents(automationId, 20, {
      include: [
        {
          model: DebtCase,
          as: 'debtCase',
          required: false,
          attributes: ['id', 'casePublicId'],
        },
      ],
    });

    const recentActivity = events.map((e) => {
      const plain = e.get ? e.get({ plain: true }) : e;
      const debtCase = plain.debtCase || {};
      return {
        id: plain.id,
        type: plain.eventType,
        at: plain.createdAt,
        caseId: plain.debtCaseId,
        casePublicId: debtCase.casePublicId ?? debtCase.case_public_id ?? null,
        actor: plain.payload?.actor ?? 'system',
        meta: plain.payload ?? {},
      };
    });

    const pms = automation.pmsConnection || {};
    const software = pms.software || {};

    return {
      automation: {
        id: automation.id,
        name: automation.strategy?.name ?? 'Automation',
        status: automation.status,
        source: software.key ?? 'unknown',
      },
      counts,
      stages,
      recentActivity,
    };
  },

  getSummary: async (tenantId, automationId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const now = new Date();
    const todayStart = startOfToday();

    const targetCases = await automationRepository.countCaseStates(automationId, { status: 'active' });
    const contactedToday = await CaseAutomationState.count({
      where: {
        automationId,
        status: 'active',
        lastAttemptAt: { [Op.gte]: todayStart },
      },
    });
    const nextScheduled = await CaseAutomationState.count({
      where: {
        automationId,
        status: 'active',
        nextActionAt: { [Op.lte]: now, [Op.ne]: null },
      },
    });
    const promisesActive = await CaseAutomationState.count({
      where: {
        automationId,
        status: 'active',
        promiseDueDate: { [Op.gte]: now.toISOString().slice(0, 10) },
      },
    });

    return {
      automationId,
      strategyName: automation.strategy?.name,
      status: automation.status,
      targetCases,
      contactedToday,
      nextScheduled,
      promisesActive,
      recovered: automation.stats?.recovered ?? 0,
    };
  },

  getCases: async (tenantId, automationId, limit = 100, offset = 0, tab = null, filters = {}, sortBy = null, sortOrder = 'ASC', search = null) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const useFilters =
      (filters.status && filters.status.length > 0) ||
      (filters.stage && filters.stage.length > 0) ||
      filters.dpdMin != null ||
      filters.dpdMax != null ||
      filters.amountMinCents != null ||
      filters.amountMaxCents != null ||
      (search && search.trim().length > 0);
    if (tab === 'disputes' && !useFilters) {
      const enrolledIds = await automationRepository.findEnrolledDebtCaseIds(automationId);
      const rows = await automationRepository.findDisputesByAutomation(automationId, tenantId, {
        limit: Math.min(limit, 200),
        offset,
      });
      const total =
        enrolledIds.length === 0
          ? 0
          : await CaseDispute.count({
              where: {
                tenantId,
                status: 'OPEN',
                debtCaseId: { [Op.in]: enrolledIds },
              },
            });
      const data = rows.map((d) => {
        const plain = d.get ? d.get({ plain: true }) : d;
        const dc = plain.debtCase || {};
        const debtor = dc.debtor || {};
        const meta = dc.meta || {};
        const pmsLease = dc.pmsLease || {};
        const pmsUnit = pmsLease?.pmsUnit || {};
        const pmsProperty = pmsUnit?.pmsProperty || {};
        const leaseNumber =
          meta.lease_number ?? meta.leaseNumber ?? pmsLease.leaseNumber ?? null;
        const unitNumber = pmsUnit.unitNumber ?? null;
        const propertyName = pmsProperty.name ?? null;
        const unitDisplay =
          propertyName && unitNumber
            ? `${propertyName} - ${unitNumber}`
            : unitNumber && leaseNumber
              ? `${unitNumber} (${leaseNumber})`
              : unitNumber ?? leaseNumber ?? propertyName ?? null;
        return {
          id: plain.id,
          debtCaseId: plain.debtCaseId,
          debtorName: debtor.fullName,
          debtorEmail: debtor.email,
          leaseNumber,
          unitDisplay,
          leaseStatus: pmsLease?.status ?? null,
          amountDueCents: dc.amountDueCents,
          daysPastDue: dc.daysPastDue,
          reason: plain.reason,
          status: plain.status,
          openedAt: plain.openedAt,
          notes: plain.notes ?? null,
          evidenceUrls: Array.isArray(plain.evidenceUrls)
            ? plain.evidenceUrls
            : Array.isArray(plain.evidence_urls)
              ? plain.evidence_urls
              : [],
          openedBy: plain.openedBy ?? plain.opened_by ?? null,
          resolvedBy: plain.resolvedBy ?? plain.resolved_by ?? null,
          resolvedAt: plain.resolvedAt ?? plain.resolved_at ?? null,
          resolution: plain.resolution ?? null,
        };
      });
      return { data, total };
    }

    const opts = {
      limit: Math.min(limit, 200),
      offset,
      tab: useFilters ? null : tab || undefined,
      filters: useFilters ? filters : undefined,
      sortBy,
      sortOrder,
      search: search && search.trim() ? search.trim() : null,
      tenantId,
    };
    const rows = await automationRepository.findCaseStates(automationId, opts);
    const total = await automationRepository.countCaseStates(automationId, {}, opts);

    const data = rows.map((s) => {
      const plain = s.get ? s.get({ plain: true }) : s;
      const debtCase = plain.debtCase || {};
      const debtor = debtCase.debtor || {};
      const meta = debtCase.meta || {};
      const pmsLease = debtCase.pmsLease || {};
      const pmsUnit = pmsLease.pmsUnit || {};
      const pmsProperty = pmsUnit.pmsProperty || {};
      const leaseNumber =
        meta.lease_number ?? meta.leaseNumber ?? pmsLease.leaseNumber ?? null;
      const unitNumber = pmsUnit.unitNumber ?? null;
      const propertyName = pmsProperty.name ?? null;
      const unitDisplay =
        propertyName && unitNumber
          ? `${propertyName} - ${unitNumber}`
          : unitNumber && leaseNumber
            ? `${unitNumber} (${leaseNumber})`
            : unitNumber ?? leaseNumber ?? propertyName ?? null;
      return {
        id: plain.id,
        debtCaseId: plain.debtCaseId,
        debtorName: debtor.fullName,
        debtorEmail: debtor.email,
        debtorPhone: debtor.phone,
        amountDueCents: debtCase.amountDueCents,
        daysPastDue: debtCase.daysPastDue,
        currency: debtCase.currency,
        leaseNumber,
        unitDisplay,
        leaseStatus: pmsLease.status ?? null,
        pmsLeaseId: debtCase.pmsLeaseId ?? debtCase.pms_lease_id ?? null,
        approvalStatus: debtCase.approvalStatus ?? debtCase.approval_status,
        debtCaseStatus: debtCase.status ?? null,
        riskTier: debtCase.riskTier ?? debtCase.risk_tier ?? null,
        dueDate: debtCase.dueDate ?? debtCase.due_date ?? null,
        lastContactedAt: debtCase.lastContactedAt ?? debtCase.last_contacted_at ?? null,
        closedAt: debtCase.closedAt ?? debtCase.closed_at ?? null,
        casePublicId: debtCase.casePublicId ?? debtCase.case_public_id ?? null,
        internalNotes: debtCase.internalNotes ?? debtCase.internal_notes ?? null,
        metaHighlights: pickDebtCaseMetaHighlights(meta),
        currentStage: plain.currentStage
          ? {
              id: plain.currentStage.id,
              name: plain.currentStage.name,
              channels: plain.currentStage.channels ?? {},
            }
          : null,
        nextActionAt: plain.nextActionAt,
        lastAttemptAt: plain.lastAttemptAt,
        lastOutcome: plain.lastOutcome,
        lastOutcomeAt: plain.lastOutcomeAt,
        attemptsWeekCount: plain.attemptsWeekCount ?? plain.attempts_week_count ?? 0,
        status: plain.status,
        promiseDueDate: plain.promiseDueDate,
        mordecaiOperationalActive:
          debtCase.mordecaiOperationalActive ?? debtCase.mordecai_operational_active ?? false,
      };
    });

    return { data, total };
  },

  bulkApprove: async (tenantId, automationId, caseIds) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    const enrolled = await automationRepository.findEnrolledDebtCaseIds(automationId);
    const valid = caseIds.filter((id) => enrolled.includes(id));
    const [count] = await DebtCase.update(
      { approvalStatus: 'APPROVED' },
      { where: { id: { [Op.in]: valid }, tenantId } }
    );
    return { approved: count };
  },

  bulkReject: async (tenantId, automationId, caseIds) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    const enrolled = await automationRepository.findEnrolledDebtCaseIds(automationId);
    const valid = caseIds.filter((id) => enrolled.includes(id));
    const [count] = await DebtCase.update(
      { approvalStatus: 'REJECTED' },
      { where: { id: { [Op.in]: valid }, tenantId } }
    );
    await CaseAutomationState.update(
      { status: 'closed' },
      { where: { debtCaseId: { [Op.in]: valid }, automationId } }
    );
    return { rejected: count };
  },

  bulkExclude: async (tenantId, automationId, caseIds) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    const enrolled = await automationRepository.findEnrolledDebtCaseIds(automationId);
    const valid = caseIds.filter((id) => enrolled.includes(id));
    const [count] = await DebtCase.update(
      { approvalStatus: 'EXCLUDED' },
      { where: { id: { [Op.in]: valid }, tenantId } }
    );
    await CaseAutomationState.update(
      { status: 'closed' },
      { where: { debtCaseId: { [Op.in]: valid }, automationId } }
    );
    return { excluded: count };
  },

  /**
   * Bulk action by filters (approve or exclude). Reuses same filter format as getCases.
   * Creates CollectionEvent for each affected case.
   */
  bulkByFilters: async (tenantId, automationId, action, filters = {}, options = {}) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const useFilters =
      (filters.status && filters.status.length > 0) ||
      (filters.stage && filters.stage.length > 0) ||
      filters.dpdMin != null ||
      filters.dpdMax != null ||
      filters.amountMinCents != null ||
      filters.amountMaxCents != null;

    const tab = useFilters ? null : action === 'approve' ? 'pending' : 'active';
    const opts = { limit: 5000, offset: 0, tab: useFilters ? null : tab, filters: useFilters ? filters : undefined };
    const rows = await automationRepository.findCaseStates(automationId, opts);
    const caseIds = rows.map((r) => r.debtCaseId ?? r.debt_case_id).filter(Boolean);

    if (caseIds.length === 0) return { affected: 0 };

    const actorId = options.actorId ?? null;
    const reason = options.reason ?? null;

    if (action === 'approve') {
      const enrolled = await automationRepository.findEnrolledDebtCaseIds(automationId);
      const valid = caseIds.filter((id) => enrolled.includes(id));
      const [count] = await DebtCase.update(
        { approvalStatus: 'APPROVED' },
        { where: { id: { [Op.in]: valid }, tenantId } }
      );
      for (const caseId of valid) {
        await CollectionEvent.create({
          automationId,
          debtCaseId: caseId,
          eventType: 'case_approved',
          payload: { actor: actorId ? 'user' : 'system', actorId, bulk: true },
        });
      }
      return { affected: count };
    }

    if (action === 'exclude') {
      const enrolled = await automationRepository.findEnrolledDebtCaseIds(automationId);
      const valid = caseIds.filter((id) => enrolled.includes(id));
      const [count] = await DebtCase.update(
        { approvalStatus: 'EXCLUDED' },
        { where: { id: { [Op.in]: valid }, tenantId } }
      );
      await CaseAutomationState.update(
        { status: 'closed' },
        { where: { debtCaseId: { [Op.in]: valid }, automationId } }
      );
      for (const caseId of valid) {
        await CollectionEvent.create({
          automationId,
          debtCaseId: caseId,
          eventType: 'case_excluded',
          payload: { actor: actorId ? 'user' : 'system', actorId, reason: reason ?? undefined, bulk: true },
        });
      }
      return { affected: count };
    }

    throw new ConflictError(`Unknown bulk action: ${action}`);
  },

  getActivity: async (tenantId, automationId, opts = {}) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const limit = Math.min(opts.limit ?? 100, 200);
    const groupBy = opts.groupBy === 'case' ? 'case' : 'day';

    const statusToEventTypes = {
      queued: ['call_queued', 'sms_queued', 'email_queued'],
      sent: ['call_queued', 'sms_sent', 'email_sent', 'payment_link_sent'],
      delivered: ['sms_sent', 'email_sent', 'payment_link_sent'],
      failed: ['call_dispatch_queue_unavailable', 'sms_failed', 'email_failed', 'sms_skipped_invalid_contact', 'email_skipped_invalid_contact', 'sms_skipped_missing_template', 'email_skipped_missing_template', 'payment_link_failed'],
      clicked: ['link_clicked'],
      opened: [],
      answered: [],
      no_answer: [],
      rejected: [],
    };
    const outcomeToEventTypes = {
      reached: [],
      promise: ['agreement_created'],
      paid: [],
      dispute: [],
      excluded: ['case_excluded'],
    };

    let eventTypes = null;
    if (opts.statuses?.length) {
      const combined = new Set();
      for (const s of opts.statuses) {
        (statusToEventTypes[s] || []).forEach((t) => combined.add(t));
      }
      if (combined.size) eventTypes = [...combined];
    }
    if (opts.outcomes?.length) {
      const combined = new Set(eventTypes || []);
      for (const o of opts.outcomes) {
        (outcomeToEventTypes[o] || []).forEach((t) => combined.add(t));
      }
      if (combined.size) eventTypes = [...combined];
    }

    const repoOpts = {
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
      search: opts.search,
      channels: opts.channels,
      eventTypes,
      stages: opts.stages,
    };

    const rows = await automationRepository.findEvents(automationId, limit, repoOpts);
    const events = rows.map((e) => {
      const plain = e.get ? e.get({ plain: true }) : e;
      const debtCase = plain.debtCase || {};
      const debtor = debtCase.debtor || {};
      const pmsLease = debtCase.pmsLease || {};
      const leaseNumber = pmsLease.leaseNumber ?? debtCase.meta?.lease_number ?? debtCase.meta?.leaseNumber ?? null;
      const casePublicId = debtCase.casePublicId ?? debtCase.case_public_id ?? null;
      return {
        id: plain.id,
        debtCaseId: plain.debtCaseId,
        casePublicId,
        debtorName: debtor.fullName || null,
        leaseNumber: leaseNumber || null,
        amountDueCents: debtCase.amountDueCents,
        currency: debtCase.currency || 'USD',
        daysPastDue: debtCase.daysPastDue,
        channel: plain.channel,
        eventType: plain.eventType,
        payload: plain.payload,
        createdAt: plain.createdAt,
      };
    });

    if (groupBy === 'case') {
      const byCase = new Map();
      for (const ev of events) {
        const key = ev.debtCaseId || ev.id;
        if (!byCase.has(key)) {
          byCase.set(key, { debtCaseId: ev.debtCaseId, casePublicId: ev.casePublicId, debtorName: ev.debtorName, leaseNumber: ev.leaseNumber, amountDueCents: ev.amountDueCents, currency: ev.currency, daysPastDue: ev.daysPastDue, events: [] });
        }
        byCase.get(key).events.push(ev);
      }
      return { groupBy: 'case', groups: [...byCase.values()].map((g) => ({ ...g, events: g.events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) })) };
    }

    const byDay = new Map();
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 864e5).toDateString();
    const formatLabel = (d) => {
      const s = new Date(d).toDateString();
      if (s === today) return 'Today';
      if (s === yesterday) return 'Yesterday';
      return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    };
    for (const ev of events) {
      const d = ev.createdAt ? new Date(ev.createdAt).toDateString() : '';
      if (!byDay.has(d)) byDay.set(d, { date: d, label: formatLabel(ev.createdAt), events: [] });
      byDay.get(d).events.push(ev);
    }
    const sortedDays = [...byDay.entries()].sort((a, b) => (b[0] > a[0] ? 1 : -1));
    const groups = sortedDays.map(([, g]) => {
      const byCase = new Map();
      for (const ev of g.events) {
        const key = ev.debtCaseId || `unknown-${ev.id}`;
        if (!byCase.has(key)) {
          byCase.set(key, {
            debtCaseId: ev.debtCaseId,
            casePublicId: ev.casePublicId,
            debtorName: ev.debtorName,
            leaseNumber: ev.leaseNumber,
            amountDueCents: ev.amountDueCents,
            currency: ev.currency,
            daysPastDue: ev.daysPastDue,
            events: [],
          });
        }
        byCase.get(key).events.push(ev);
      }

      const cases = [...byCase.values()].map((c) => {
        const orderedEvents = c.events.sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );
        const eventTypeCounts = orderedEvents.reduce((acc, ev) => {
          acc[ev.eventType] = (acc[ev.eventType] || 0) + 1;
          return acc;
        }, {});
        const channels = [...new Set(orderedEvents.map((ev) => ev.channel).filter(Boolean))];
        return {
          ...c,
          totalEvents: orderedEvents.length,
          channels,
          eventTypeCounts,
          lastEvent: orderedEvents[0] || null,
          events: orderedEvents,
        };
      });

      return {
        ...g,
        events: g.events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
        cases: cases.sort((a, b) => {
          const at = a.lastEvent?.createdAt || '';
          const bt = b.lastEvent?.createdAt || '';
          return new Date(bt) - new Date(at);
        }),
      };
    });

    return { groupBy: 'day', groups };
  },

  getCaseTimeline: async (tenantId, automationId, debtCaseId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const [events, interactionLogs, debtCaseRow] = await Promise.all([
      automationRepository.findCaseTimeline(automationId, debtCaseId),
      InteractionLog.findAll({
        where: { tenantId, debtCaseId, type: 'CALL' },
        order: [['createdAt', 'ASC']],
        limit: 50,
      }),
      DebtCase.findByPk(debtCaseId, {
        include: [
          { model: Debtor, as: 'debtor', attributes: ['id', 'fullName', 'email', 'phone'] },
          { model: PmsLease, as: 'pmsLease', attributes: ['id', 'leaseNumber'] },
        ],
      }),
    ]);

    const dc = debtCaseRow?.get ? debtCaseRow.get({ plain: true }) : debtCaseRow;
    const debtor = dc?.debtor || {};
    const pmsLease = dc?.pmsLease || {};
    const leaseNumber = pmsLease.leaseNumber ?? dc?.meta?.lease_number ?? dc?.meta?.leaseNumber ?? null;

    return {
      debtCase: dc
        ? {
          id: dc.id,
          casePublicId: dc.casePublicId ?? dc.case_public_id,
          amountDueCents: dc.amountDueCents ?? dc.amount_due_cents,
          currency: dc.currency || 'USD',
          daysPastDue: dc.daysPastDue ?? dc.days_past_due,
          dueDate: dc.dueDate ?? dc.due_date ?? null,
          status: dc.status ?? null,
          approvalStatus: dc.approvalStatus ?? dc.approval_status,
          lastContactedAt: dc.lastContactedAt ?? dc.last_contacted_at ?? null,
          closedAt: dc.closedAt ?? dc.closed_at ?? null,
          riskTier: dc.riskTier ?? dc.risk_tier ?? null,
          internalNotes: dc.internalNotes ?? dc.internal_notes ?? null,
          metaHighlights: pickDebtCaseMetaHighlights(dc.meta || {}),
          debtorName: debtor?.fullName ?? debtor?.full_name,
          debtorId: debtor?.id ?? null,
          debtorEmail: debtor?.email ?? null,
          debtorPhone: debtor?.phone ?? null,
          leaseNumber,
        }
        : null,
      events: [
        ...events.map((e) => {
          const plain = e.get ? e.get({ plain: true }) : e;
          return {
            id: plain.id,
            channel: plain.channel,
            eventType: plain.eventType,
            payload: plain.payload,
            createdAt: plain.createdAt,
          };
        }),
        ...interactionLogs.map((log) => {
          const plain = log.get ? log.get({ plain: true }) : log;
          const callEventType =
            plain.status === 'failed'
              ? 'call_failed'
              : plain.status === 'completed'
                ? 'call_completed'
                : plain.status === 'in_progress'
                  ? 'call_in_progress'
                  : 'call_queued';
          return {
            id: `interaction-${plain.id}`,
            channel: 'call',
            eventType: callEventType,
            payload: {
              interactionLogId: plain.id,
              providerRef: plain.providerRef ?? null,
              status: plain.status,
              outcome: plain.outcome ?? null,
              summary: plain.summary ?? null,
              error: plain.error ?? null,
              s3Key: plain.aiData?.eleven?.s3_key ?? null,
            },
            createdAt: plain.createdAt,
          };
        }),
      ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).map((plain) => {
        return {
          id: plain.id,
          channel: plain.channel,
          eventType: plain.eventType,
          payload: plain.payload,
          createdAt: plain.createdAt,
        };
      }),
    };
  },

  getAgreements: async (tenantId, automationId, options = {}) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const agreements = await automationRepository.findAgreements(automationId, tenantId, {
      agreementStatuses: options.agreementStatuses,
    });
    return agreements.map((a) => {
      const plain = a.get ? a.get({ plain: true }) : a;
      const debtCase = plain.debtCase || {};
      const debtor = debtCase.debtor || {};
      const rawSchedule = Array.isArray(plain.installmentSchedule) ? plain.installmentSchedule : [];
      const installmentSchedule = [...rawSchedule]
        .sort(
          (x, y) =>
            (Number(x.installmentNum ?? x.installment_num) || 0) -
            (Number(y.installmentNum ?? y.installment_num) || 0)
        )
        .map((row) => ({
          installmentNum: row.installmentNum ?? row.installment_num,
          dueDate: row.dueDate ?? row.due_date,
          amountCents: Number(row.amountCents ?? row.amount_cents ?? 0),
          status: row.status ?? 'PENDING',
          paidAt: row.paidAt ?? row.paid_at ?? null,
          paidAmountCents:
            row.paidAmountCents != null
              ? Number(row.paidAmountCents)
              : row.paid_amount_cents != null
                ? Number(row.paid_amount_cents)
                : null,
          source: row.source ?? null,
        }));
      const fallbackFirstDue = extractFirstDueYmdFromAgreementTerms(plain.terms);
      const scheduleFirstDue = installmentSchedule[0]?.dueDate ?? null;
      const promiseDate =
        plain.promiseDate ||
        (plain.type === 'PROMISE_TO_PAY'
          ? fallbackFirstDue || scheduleFirstDue || null
          : null);
      const startDate =
        plain.startDate ||
        (plain.type === 'INSTALLMENTS'
          ? fallbackFirstDue || scheduleFirstDue || null
          : null);
      const proofUrls = plain.paymentProofUrls ?? plain.payment_proof_urls;
      const proofList = Array.isArray(proofUrls) ? proofUrls : [];
      return {
        id: plain.id,
        debtCaseId: plain.debtCaseId,
        type: plain.type,
        status: plain.status,
        totalAmountCents: plain.totalAmountCents,
        downPaymentCents: plain.downPaymentCents,
        installments: plain.installments,
        promiseDate,
        startDate,
        paymentLinkUrl: plain.paymentLinkUrl,
        createdAt: plain.createdAt,
        createdBy: plain.createdBy ?? plain.created_by ?? null,
        provider: plain.provider ?? null,
        providerRef: plain.providerRef ?? plain.provider_ref ?? null,
        paymentProofUrls: proofList,
        termsSummary: summarizeAgreementTermsForUi(plain.terms),
        debtorName: debtor.fullName,
        debtorEmail: debtor.email,
        debtorPhone: debtor.phone,
        currency: debtCase.currency || 'USD',
        installmentSchedule,
      };
    });
  },

  enroll: async (tenantId, automationId, options = {}) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const strategy = automation.strategy;
    if (!strategy) throw new NotFoundError('Strategy');
    const stages = strategy.stages || [];
    if (stages.length === 0) {
      throw new ConflictError('Strategy has no stages; add stages before enrolling cases');
    }

    let debtCases;
    if (options.debtCaseIds && options.debtCaseIds.length > 0) {
      debtCases = await DebtCase.findAll({
        where: { id: { [Op.in]: options.debtCaseIds }, tenantId },
        include: [{ model: Debtor, as: 'debtor', attributes: ['id', 'phone', 'email'] }],
        limit: 500,
      });
      if (debtCases.length !== options.debtCaseIds.length) {
        throw new NotFoundError('DebtCase');
      }
      const inactive = debtCases.filter((dc) => !dc.mordecaiOperationalActive);
      if (inactive.length > 0) {
        throw new ConflictError(
          'Activate the debt case in Mordecai (free trial or subscription) before enrolling it in an automation.'
        );
      }
    } else {
      const alreadyEnrolled = await automationRepository.findEnrolledDebtCaseIds(automationId);
      debtCases = await DebtCase.findAll({
        where: {
          tenantId,
          mordecaiOperationalActive: true,
          status: { [Op.in]: ELIGIBLE_STATUSES },
          ...(alreadyEnrolled.length > 0 ? { id: { [Op.notIn]: alreadyEnrolled } } : {}),
        },
        include: [{ model: Debtor, as: 'debtor', attributes: ['id', 'phone', 'email'] }],
        limit: 1000,
      });
    }

    const now = new Date();
    let enrolled = 0;
    const errors = [];

    for (const dc of debtCases) {
      try {
        const existing = await CaseAutomationState.findOne({
          where: { debtCaseId: dc.id, automationId },
        });
        if (existing) {
          continue;
        }
        const stage = selectStageByDaysPastDue(stages, dc.daysPastDue ?? 0);
        if (!stage) continue;

        const approvalStatus = resolveApprovalStatus(dc, automation, stage, dc.debtor);
        if (dc.approvalStatus !== approvalStatus) {
          await dc.update({ approvalStatus });
        }

        await CaseAutomationState.create({
          debtCaseId: dc.id,
          automationId,
          strategyId: automation.strategyId,
          currentStageId: stage.id,
          status: 'active',
          nextActionAt: now,
          attemptsWeekCount: 0,
          meta: {},
        });
        enrolled++;
      } catch (err) {
        errors.push({ debtCaseId: dc.id, message: err.message });
      }
    }

    return { enrolled, skipped: debtCases.length - enrolled - errors.length, total: debtCases.length, errors: errors.length ? errors : undefined };
  },

  /**
   * Recompute currentStageId for all enrolled cases based on debt case daysPastDue.
   * Use after build-cases updates DPD so stages (early/mid/late) match reality.
   */
  recomputeStagesForAutomation: async (tenantId, automationId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');
    const strategy = automation.strategy;
    const stages = strategy?.stages || [];
    if (stages.length === 0) return { updated: 0 };

    const states = await CaseAutomationState.findAll({
      where: { automationId },
      include: [{ model: DebtCase, as: 'debtCase', attributes: ['id', 'daysPastDue'], required: true }],
    });
    let updated = 0;
    for (const state of states) {
      const dpd = state.debtCase?.daysPastDue ?? 0;
      const stage = selectStageByDaysPastDue(stages, dpd);
      if (stage && stage.id !== state.currentStageId) {
        await state.update({ currentStageId: stage.id });
        updated++;
      }
    }
    return { updated };
  },

  /**
   * Run the full strategy (call, SMS, email per current stage) for a single case on-demand.
   * Enqueues jobs for each enabled channel.
   */
  runStrategyForCase: async (tenantId, automationId, debtCaseId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const state = await CaseAutomationState.findOne({
      where: { debtCaseId, automationId },
      include: [
        { model: DebtCase, as: 'debtCase', required: true, include: [{ model: Debtor, as: 'debtor', required: false }] },
        { model: CollectionStage, as: 'currentStage', required: false },
      ],
    });

    if (!state) throw new NotFoundError('Case is not enrolled in this automation');

    if (!state.debtCase?.mordecaiOperationalActive) {
      throw new ConflictError('Case is paused in Mordecai; activate it before running the strategy.');
    }

    const approvalStatus = state.debtCase?.approvalStatus ?? state.debtCase?.approval_status;
    if (approvalStatus !== 'APPROVED') {
      throw new ConflictError('Case must be approved before running strategy');
    }

    const openDispute = await CaseDispute.findOne({
      where: { debtCaseId, status: 'OPEN' },
    });
    if (openDispute) {
      throw new ConflictError('Case has an open dispute; resolve it before running strategy');
    }

    const stage = state.currentStage || null;
    const dispatchChannels = resolveDispatchChannels(stage?.channels || {});

    if (dispatchChannels.length === 0) {
      return {
        message: 'No channel enabled in current stage',
        queued: [],
      };
    }

    await expireStaleCallInteractionsForDebtCase(tenantId, debtCaseId);

    const now = new Date();
    const outcomes = [];

    for (const channel of dispatchChannels) {
      if (channel === 'call') {
        const jobId = await addCaseActionJob(CASE_ACTION_JOB_TYPES.CALL_CASE, {
          tenantId: automation.tenantId,
          caseId: state.debtCaseId,
          automationId: automation.id,
          stateId: state.id,
        });
        if (jobId) {
          outcomes.push('call_queued');
          await CollectionEvent.create({
            automationId,
            debtCaseId: state.debtCaseId,
            channel: 'call',
            eventType: 'call_queued',
            payload: { jobId },
          });
        } else {
          outcomes.push('call_dispatch_queue_unavailable');
        }
        continue;
      }
      if (channel === 'sms') {
        const smsTemplate = await resolveChannelTemplate({
          tenantId: automation.tenantId,
          channel: 'sms',
          stage,
        });
        if (!smsTemplate.template) {
          outcomes.push('sms_skipped_missing_template');
          await CollectionEvent.create({
            automationId,
            debtCaseId: state.debtCaseId,
            channel: 'sms',
            eventType: 'sms_skipped_missing_template',
            payload: {
              reason: resolveMissingTemplateMessage('sms', smsTemplate.reason),
              templateReason: smsTemplate.reason,
            },
          });
          continue;
        }

        const jobId = await addCaseActionJob(CASE_ACTION_JOB_TYPES.SMS_CASE, {
          tenantId: automation.tenantId,
          caseId: state.debtCaseId,
          automationId: automation.id,
          stateId: state.id,
        });
        if (jobId) {
          outcomes.push('sms_queued');
          await CollectionEvent.create({
            automationId,
            debtCaseId: state.debtCaseId,
            channel: 'sms',
            eventType: 'sms_queued',
            payload: { jobId },
          });
        } else {
          outcomes.push('sms_dispatch_queue_unavailable');
        }
        continue;
      }
      if (channel === 'email') {
        const emailTemplate = await resolveChannelTemplate({
          tenantId: automation.tenantId,
          channel: 'email',
          stage,
        });
        if (!emailTemplate.template) {
          outcomes.push('email_skipped_missing_template');
          await CollectionEvent.create({
            automationId,
            debtCaseId: state.debtCaseId,
            channel: 'email',
            eventType: 'email_skipped_missing_template',
            payload: {
              reason: resolveMissingTemplateMessage('email', emailTemplate.reason),
              templateReason: emailTemplate.reason,
            },
          });
          continue;
        }

        const jobId = await addCaseActionJob(CASE_ACTION_JOB_TYPES.EMAIL_CASE, {
          tenantId: automation.tenantId,
          caseId: state.debtCaseId,
          automationId: automation.id,
          stateId: state.id,
        });
        if (jobId) {
          outcomes.push('email_queued');
          await CollectionEvent.create({
            automationId,
            debtCaseId: state.debtCaseId,
            channel: 'email',
            eventType: 'email_queued',
            payload: { jobId },
          });
        } else {
          outcomes.push('email_dispatch_queue_unavailable');
        }
        continue;
      }
    }

    const outcome = outcomes.length > 0 ? outcomes.join(',') : 'dispatch_skipped_no_channel';
    await state.update({
      lastAttemptAt: now,
      nextActionAt: now,
      attemptsWeekCount: (state.attemptsWeekCount ?? 0) + 1,
      lastOutcome: outcome,
      lastOutcomeAt: now,
    });

    return {
      message: `Strategy executed: ${outcomes.filter((o) => o.endsWith('_queued')).length} channel(s) queued`,
      queued: outcomes.filter((o) => o.endsWith('_queued')),
    };
  },

  /**
   * Trigger SMS for a case independently (from Cases tab "Send message" button).
   */
  triggerCaseSms: async (tenantId, automationId, debtCaseId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const state = await CaseAutomationState.findOne({
      where: { debtCaseId, automationId },
      include: [
        { model: DebtCase, as: 'debtCase', required: true, include: [{ model: Debtor, as: 'debtor', required: false }] },
        { model: CollectionStage, as: 'currentStage', required: false },
      ],
    });

    if (!state) throw new NotFoundError('Case is not enrolled in this automation');
    if (!state.debtCase?.mordecaiOperationalActive) {
      throw new ConflictError('Case is paused in Mordecai; activate it before sending SMS.');
    }
    if (!isStageChannelEnabled(state, 'sms')) {
      throw new ConflictError('SMS is disabled for this case stage');
    }
    const smsTemplate = await resolveChannelTemplate({
      tenantId: automation.tenantId,
      channel: 'sms',
      stage: state.currentStage || null,
    });
    if (!smsTemplate.template) {
      throw new ConflictError(resolveMissingTemplateMessage('sms', smsTemplate.reason));
    }
    if ((state.debtCase?.debtor?.phone || '').trim() === '') {
      throw new ConflictError('Case has no phone number');
    }

    const inlineSms =
      process.env.DISPATCH_SMS_INLINE === 'true' ||
      process.env.DISPATCH_SMS_INLINE === '1';

    if (inlineSms) {
      logger.info(
        {
          tenantId: automation.tenantId,
          debtCaseId: state.debtCaseId,
          automationId: automation.id,
        },
        'DISPATCH_SMS_INLINE: sending collection SMS in-process (no queue)'
      );
      const dispatchResult = await runSmsCaseDispatch({
        tenantId: automation.tenantId,
        caseId: state.debtCaseId,
        automationId: automation.id,
        stateId: state.id,
      });
      if (!dispatchResult?.ok) {
        throw new ConflictError(
          dispatchResult?.message || 'SMS could not be sent'
        );
      }
      return {
        enqueued: false,
        inline: true,
        interactionLogId: dispatchResult.interactionLogId,
        providerRef: dispatchResult.providerRef,
        message: 'SMS sent',
      };
    }

    const jobId = await addCaseActionJob(CASE_ACTION_JOB_TYPES.SMS_CASE, {
      tenantId: automation.tenantId,
      caseId: state.debtCaseId,
      automationId: automation.id,
      stateId: state.id,
    });

    if (!jobId) {
      throw new ConflictError('SMS queue unavailable. Ensure REDIS_URL is set and worker is running.');
    }

    const redisTarget = (() => {
      const raw = process.env.REDIS_URL;
      if (!raw) return null;
      try {
        return new URL(raw).host;
      } catch {
        return 'invalid-redis-url';
      }
    })();

    logger.info(
      {
        jobId,
        debtCaseId: state.debtCaseId,
        automationId: automation.id,
        redisHost: redisTarget,
        bullmqPrefix: getBullmqPrefix() || 'bull (default)',
      },
      'SMS_CASE job enqueued — worker must use same REDIS_URL and BULLMQ_PREFIX'
    );

    await CollectionEvent.create({
      automationId,
      debtCaseId: state.debtCaseId,
      channel: 'sms',
      eventType: 'sms_queued',
      payload: { jobId },
    });

    return { enqueued: true, jobId, message: 'SMS enqueued' };
  },

  /**
   * Trigger Email for a case independently (from Cases tab "Email" button).
   */
  triggerCaseEmail: async (tenantId, automationId, debtCaseId) => {
    const automation = await automationRepository.findById(automationId, tenantId);
    if (!automation) throw new NotFoundError('Automation');

    const state = await CaseAutomationState.findOne({
      where: { debtCaseId, automationId },
      include: [
        { model: DebtCase, as: 'debtCase', required: true, include: [{ model: Debtor, as: 'debtor', required: false }] },
        { model: CollectionStage, as: 'currentStage', required: false },
      ],
    });

    if (!state) throw new NotFoundError('Case is not enrolled in this automation');
    if (!state.debtCase?.mordecaiOperationalActive) {
      throw new ConflictError('Case is paused in Mordecai; activate it before sending email.');
    }
    if (!isStageChannelEnabled(state, 'email')) {
      throw new ConflictError('Email is disabled for this case stage');
    }
    const emailTemplate = await resolveChannelTemplate({
      tenantId: automation.tenantId,
      channel: 'email',
      stage: state.currentStage || null,
    });
    if (!emailTemplate.template) {
      throw new ConflictError(resolveMissingTemplateMessage('email', emailTemplate.reason));
    }
    if ((state.debtCase?.debtor?.email || '').trim() === '') {
      throw new ConflictError('Case has no email');
    }

    const jobId = await addCaseActionJob(CASE_ACTION_JOB_TYPES.EMAIL_CASE, {
      tenantId: automation.tenantId,
      caseId: state.debtCaseId,
      automationId: automation.id,
      stateId: state.id,
    });

    if (!jobId) {
      throw new ConflictError('Email queue unavailable. Ensure REDIS_URL is set and worker is running.');
    }

    await CollectionEvent.create({
      automationId,
      debtCaseId: state.debtCaseId,
      channel: 'email',
      eventType: 'email_queued',
      payload: { jobId },
    });

    return { enqueued: true, jobId, message: 'Email enqueued' };
  },
};
