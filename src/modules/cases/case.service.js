import { caseRepository } from './case.repository.js';
import { tenantRepository } from '../tenants/tenant.repository.js';
import { NotFoundError, BadRequestError } from '../../errors/index.js';
import { Debtor, PmsDebtor } from '../../models/index.js';
import { addCallCaseJob, getCaseActionsQueue } from '../../queues/case-actions.queue.js';
import { expireStaleCallInteractionsForDebtCase } from '../elevenlabs/eleven.service.js';

export const caseService = {
  getDetail: async (tenantId, debtCaseId) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const debtCase = await caseRepository.findDebtCaseById(debtCaseId, tenantId);
    if (!debtCase) throw new NotFoundError('Case');

    const plain = debtCase.get ? debtCase.get({ plain: true }) : debtCase;
    return {
      id: plain.id,
      tenantId: plain.tenantId,
      debtorId: plain.debtorId,
      amountDueCents: plain.amountDueCents,
      currency: plain.currency,
      daysPastDue: plain.daysPastDue,
      dueDate: plain.dueDate,
      status: plain.status,
      lastContactedAt: plain.lastContactedAt,
      nextActionAt: plain.nextActionAt,
      closedAt: plain.closedAt,
      debtor: plain.debtor,
      automationStates: (plain.automationStates || []).map((s) => ({
        id: s.id,
        automationId: s.automationId,
        strategyId: s.strategyId,
        automation: s.automation,
        currentStage: s.currentStage,
        status: s.status,
        nextActionAt: s.nextActionAt,
        lastAttemptAt: s.lastAttemptAt,
        lastOutcome: s.lastOutcome,
        lastOutcomeAt: s.lastOutcomeAt,
        promiseDueDate: s.promiseDueDate,
        attemptsWeekCount: s.attemptsWeekCount,
      })),
    };
  },

  getTimeline: async (tenantId, debtCaseId, limit = 50) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const debtCase = await caseRepository.findDebtCaseById(debtCaseId, tenantId);
    if (!debtCase) throw new NotFoundError('Case');

    const [events, logs] = await Promise.all([
      caseRepository.findEventsByDebtCaseId(debtCaseId, limit),
      caseRepository.findInteractionLogsByDebtCaseId(debtCaseId, limit),
    ]);

    const eventItems = events.map((e) => {
      const p = e.get ? e.get({ plain: true }) : e;
      return { type: 'collection_event', ...p };
    });
    const logItems = logs.map((l) => {
      const p = l.get ? l.get({ plain: true }) : l;
      return { type: 'interaction_log', ...p };
    });
    const combined = [...eventItems, ...logItems].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    return combined.slice(0, limit);
  },

  pause: async (tenantId, debtCaseId, automationId = null) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const debtCase = await caseRepository.findDebtCaseById(debtCaseId, tenantId);
    if (!debtCase) throw new NotFoundError('Case');

    const states = debtCase.automationStates || [];
    const toPause = automationId ? states.filter((s) => s.automationId === automationId) : states;
    if (toPause.length === 0) {
      throw new NotFoundError(automationId ? 'Case automation state' : 'No automation state found for this case');
    }

    for (const s of toPause) {
      await caseRepository.updateCaseAutomationStateById(s.id, { status: 'paused' });
    }
    return { paused: true, count: toPause.length };
  },

  resume: async (tenantId, debtCaseId, automationId = null) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const debtCase = await caseRepository.findDebtCaseById(debtCaseId, tenantId);
    if (!debtCase) throw new NotFoundError('Case');

    const states = debtCase.automationStates || [];
    const toResume = automationId ? states.filter((s) => s.automationId === automationId) : states;
    if (toResume.length === 0) {
      throw new NotFoundError(automationId ? 'Case automation state' : 'No automation state found for this case');
    }

    for (const s of toResume) {
      await caseRepository.updateCaseAutomationStateById(s.id, { status: 'active' });
    }
    return { resumed: true, count: toResume.length };
  },

  /**
   * Trigger an on-demand call for a debt case. For controlled testing and specific use cases.
   * Enqueues a CALL_CASE job; the worker will process it.
   */
  triggerCall: async (tenantId, debtCaseId, options = {}) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const debtCase = await caseRepository.findDebtCaseById(debtCaseId, tenantId);
    if (!debtCase) throw new NotFoundError('Case');

    const queue = getCaseActionsQueue();
    if (!queue) {
      throw new BadRequestError(
        'Call queue is not available. Set REDIS_URL and ensure the worker is running.'
      );
    }

    const plain = debtCase.get ? debtCase.get({ plain: true }) : debtCase;
    const debtor = plain.debtor;
    if (!debtor?.phone) {
      throw new BadRequestError('Case has no phone number. Add a phone to the debtor to place a call.');
    }

    await expireStaleCallInteractionsForDebtCase(tenantId, debtCaseId);

    const jobId = await addCallCaseJob(tenantId, debtCaseId, {
      followUp: Boolean(options.followUp),
    });
    if (!jobId) {
      throw new BadRequestError(
        'Could not enqueue call. Set REDIS_URL and ensure the worker is running.'
      );
    }

    return { enqueued: true, jobId, message: 'Call enqueued. The worker will place the call shortly.' };
  },

  /**
   * Correct resident contact on the canonical debtor (and linked PMS debtor when known)
   * so SMS/email/calls and the next PMS sync stay aligned.
   */
  updateDebtorForCase: async (tenantId, debtCaseId, body) => {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) throw new NotFoundError('Tenant');

    const debtCase = await caseRepository.findDebtCaseById(debtCaseId, tenantId);
    if (!debtCase) throw new NotFoundError('Case');

    const plain = debtCase.get ? debtCase.get({ plain: true }) : debtCase;
    const debtorId = plain.debtorId;
    const debtorRow = plain.debtor || {};
    const meta = plain.meta || {};

    const updates = {};
    if (body.fullName !== undefined) {
      const n = String(body.fullName).trim();
      if (!n) throw new BadRequestError('fullName cannot be empty');
      updates.fullName = n;
    }
    if (body.email !== undefined) {
      const e =
        body.email === null || body.email === ''
          ? null
          : String(body.email).trim();
      updates.email = e || null;
    }
    if (body.phone !== undefined) {
      const raw =
        body.phone === null || body.phone === ''
          ? null
          : String(body.phone).trim().replace(/[\s()-]/g, '');
      updates.phone = raw || null;
    }
    if (Object.keys(updates).length === 0) {
      throw new BadRequestError('Provide at least one of: fullName, email, phone');
    }

    const debtor = await Debtor.findOne({ where: { id: debtorId, tenantId } });
    if (!debtor) throw new NotFoundError('Debtor');

    await debtor.update(updates);

    const pmsDebtorId = meta.pms_debtor_id ?? debtorRow.metadata?.pms_debtor_id;
    if (pmsDebtorId) {
      const pmsUpdates = {};
      if (updates.fullName !== undefined) pmsUpdates.displayName = updates.fullName;
      if (updates.email !== undefined) pmsUpdates.email = updates.email;
      if (updates.phone !== undefined) pmsUpdates.phone = updates.phone;
      if (Object.keys(pmsUpdates).length > 0) {
        await PmsDebtor.update(pmsUpdates, { where: { id: pmsDebtorId, tenantId } });
      }
    }

    await debtor.reload();
    return {
      id: debtor.id,
      fullName: debtor.fullName,
      email: debtor.email,
      phone: debtor.phone,
    };
  },
};
