import { automationService } from './automation.service.js';

export const automationController = {
  list: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      const pmsConnectionId = req.query.pmsConnectionId || null;
      const result = await automationService.list(tenantId, pmsConnectionId);
      res.ok(result, 'Automations retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  getById: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const result = await automationService.getById(tenantId, automationId);
      res.ok(result, 'Automation retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  update: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const result = await automationService.update(tenantId, automationId, req.body);
      res.ok(result, 'Automation updated');
    } catch (error) {
      next(error);
    }
  },

  create: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      const result = await automationService.create(tenantId, req.body);
      res.created(result, 'Automation created successfully');
    } catch (error) {
      next(error);
    }
  },

  activate: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const result = await automationService.activate(tenantId, automationId);
      res.ok(result, 'Automation activated');
    } catch (error) {
      next(error);
    }
  },

  pause: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const result = await automationService.pause(tenantId, automationId);
      res.ok(result, 'Automation paused');
    } catch (error) {
      next(error);
    }
  },

  stop: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const result = await automationService.stop(tenantId, automationId);
      res.ok(result, 'Automation stopped');
    } catch (error) {
      next(error);
    }
  },

  delete: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const result = await automationService.delete(tenantId, automationId);
      res.ok(result, 'Automation deleted');
    } catch (error) {
      next(error);
    }
  },

  getSummary: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const result = await automationService.getSummary(tenantId, automationId);
      res.ok(result, 'Automation summary retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  getOverview: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const result = await automationService.getOverview(tenantId, automationId);
      res.ok(result, 'Automation overview retrieved');
    } catch (error) {
      next(error);
    }
  },

  getCases: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const limit = parseInt(req.query.limit, 10) || 100;
      const offset = parseInt(req.query.offset, 10) || 0;
      const tab = req.query.tab || null;
      const filters = {};
      if (req.query.status) {
        const raw = String(req.query.status)
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'EXCLUDED', 'IN_DISPUTE'].includes(s))
          .map((s) => (s === 'ACTIVE' ? 'APPROVED' : s));
        filters.status = [...new Set(raw)];
      }
      if (req.query.stage) filters.stage = String(req.query.stage).split(',').map((s) => s.trim()).filter(Boolean);
      if (req.query.dpdMin != null) filters.dpdMin = parseInt(req.query.dpdMin, 10);
      if (req.query.dpdMax != null) filters.dpdMax = parseInt(req.query.dpdMax, 10);
      if (req.query.amountMinCents != null) filters.amountMinCents = parseInt(req.query.amountMinCents, 10);
      if (req.query.amountMaxCents != null) filters.amountMaxCents = parseInt(req.query.amountMaxCents, 10);
      const sortBy = ['debtorName', 'amountDueCents', 'daysPastDue', 'approvalStatus'].includes(req.query.sortBy)
        ? req.query.sortBy
        : null;
      const sortOrder = req.query.sortOrder === 'desc' ? 'DESC' : 'ASC';
      const search = req.query.search && String(req.query.search).trim() ? String(req.query.search).trim() : null;
      const result = await automationService.getCases(tenantId, automationId, limit, offset, tab, filters, sortBy, sortOrder, search);
      res.ok(result, 'Automation cases retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  bulkApprove: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const caseIds = req.body?.caseIds ?? [];
      const result = await automationService.bulkApprove(tenantId, automationId, caseIds);
      res.ok(result, 'Cases approved');
    } catch (error) {
      next(error);
    }
  },

  bulkReject: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const caseIds = req.body?.caseIds ?? [];
      const result = await automationService.bulkReject(tenantId, automationId, caseIds);
      res.ok(result, 'Cases rejected');
    } catch (error) {
      next(error);
    }
  },

  bulkExclude: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const caseIds = req.body?.caseIds ?? [];
      const result = await automationService.bulkExclude(tenantId, automationId, caseIds);
      res.ok(result, 'Cases excluded');
    } catch (error) {
      next(error);
    }
  },

  bulkByFilters: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const { action, filters = {}, reason } = req.body ?? {};
      const actorId = req.user?.id ?? null;
      const result = await automationService.bulkByFilters(tenantId, automationId, action, filters, {
        actorId,
        reason,
      });
      res.ok({ affected: result.affected }, `${action === 'approve' ? 'Approved' : 'Excluded'} ${result.affected} case(s)`);
    } catch (error) {
      next(error);
    }
  },

  getActivity: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const limit = parseInt(req.query.limit, 10) || 100;
      let dateFrom = req.query.dateFrom || null;
      let dateTo = req.query.dateTo || null;
      if (!dateFrom && !dateTo) {
        const now = new Date();
        dateTo = now.toISOString();
        dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      }
      const search = req.query.search ? String(req.query.search).trim() || null : null;
      const groupBy = req.query.groupBy === 'case' ? 'case' : 'day';
      const channels = req.query.channels ? String(req.query.channels).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;
      const statuses = req.query.statuses ? String(req.query.statuses).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;
      const outcomes = req.query.outcomes ? String(req.query.outcomes).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : undefined;
      const stages = req.query.stages ? String(req.query.stages).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const result = await automationService.getActivity(tenantId, automationId, {
        limit,
        dateFrom,
        dateTo,
        search,
        groupBy,
        channels,
        statuses,
        outcomes,
        stages,
      });
      res.ok(result, 'Automation activity retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  getCaseTimeline: async (req, res, next) => {
    try {
      const { tenantId, automationId, debtCaseId } = req.params;
      const result = await automationService.getCaseTimeline(tenantId, automationId, debtCaseId);
      res.ok(result, 'Case timeline retrieved');
    } catch (error) {
      next(error);
    }
  },

  getAgreements: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const ALLOWED = new Set([
        'PROPOSED',
        'PENDING',
        'ACTIVE',
        'ACCEPTED',
        'SUPERSEDED',
        'CANCELLED',
        'COMPLETED',
        'BROKEN',
      ]);
      const raw = req.query.status;
      let agreementStatuses = null;
      if (raw != null && String(raw).trim()) {
        agreementStatuses = String(raw)
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => ALLOWED.has(s));
        if (agreementStatuses.length === 0) agreementStatuses = null;
      }
      const result = await automationService.getAgreements(tenantId, automationId, {
        agreementStatuses,
      });
      res.ok(result, 'Automation agreements retrieved successfully');
    } catch (error) {
      next(error);
    }
  },

  enroll: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const debtCaseIds = req.body?.debtCaseIds;
      const result = await automationService.enroll(tenantId, automationId, {
        debtCaseIds: Array.isArray(debtCaseIds) ? debtCaseIds : undefined,
      });
      res.ok(result, 'Enrollment completed');
    } catch (error) {
      next(error);
    }
  },

  recomputeStages: async (req, res, next) => {
    try {
      const { tenantId, automationId } = req.params;
      const result = await automationService.recomputeStagesForAutomation(tenantId, automationId);
      res.ok(result, 'Stages recomputed');
    } catch (error) {
      next(error);
    }
  },

  runStrategyForCase: async (req, res, next) => {
    try {
      const { tenantId, automationId, debtCaseId } = req.params;
      const result = await automationService.runStrategyForCase(tenantId, automationId, debtCaseId);
      res.ok(result, result.message || 'Strategy execution enqueued');
    } catch (error) {
      next(error);
    }
  },

  triggerCaseSms: async (req, res, next) => {
    try {
      const { tenantId, automationId, debtCaseId } = req.params;
      const result = await automationService.triggerCaseSms(tenantId, automationId, debtCaseId);
      res.ok(result, result.message || 'SMS enqueued');
    } catch (error) {
      next(error);
    }
  },

  triggerCaseEmail: async (req, res, next) => {
    try {
      const { tenantId, automationId, debtCaseId } = req.params;
      const result = await automationService.triggerCaseEmail(tenantId, automationId, debtCaseId);
      res.ok(result, result.message || 'Email enqueued');
    } catch (error) {
      next(error);
    }
  },
};
