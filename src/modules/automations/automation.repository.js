import {
  CollectionAutomation,
  CollectionStrategy,
  CollectionEvent,
  CaseAutomationState,
  DebtCase,
  Debtor,
  PmsConnection,
  PmsLease,
  PmsUnit,
  PmsProperty,
  CollectionStage,
  PaymentAgreement,
  PaymentAgreementInstallment,
  CaseDispute,
} from '../../models/index.js';
import { Op } from 'sequelize';
import { logger } from '../../utils/logger.js';

export const automationRepository = {
  findByTenant: async (tenantId, options = {}) => {
    try {
      const where = { tenantId };
      return await CollectionAutomation.findAll({
        where,
        include: [
          { model: PmsConnection, as: 'pmsConnection', attributes: ['id', 'softwareId', 'status'], include: [{ association: 'software', attributes: ['id', 'key', 'name'] }] },
          { model: CollectionStrategy, as: 'strategy', attributes: ['id', 'name', 'isActive'] },
        ],
        order: [['createdAt', 'DESC']],
        ...options,
      });
    } catch (error) {
      logger.error({ error, tenantId }, 'Error finding automations');
      throw error;
    }
  },

  findByConnection: async (tenantId, pmsConnectionId, options = {}) => {
    try {
      return await CollectionAutomation.findAll({
        where: { tenantId, pmsConnectionId },
        include: [
          { model: PmsConnection, as: 'pmsConnection', attributes: ['id', 'softwareId', 'status'] },
          { model: CollectionStrategy, as: 'strategy', attributes: ['id', 'name', 'isActive'] },
        ],
        order: [['createdAt', 'DESC']],
        ...options,
      });
    } catch (error) {
      logger.error({ error, tenantId, pmsConnectionId }, 'Error finding automations by connection');
      throw error;
    }
  },

  findById: async (id, tenantId, options = {}) => {
    try {
      return await CollectionAutomation.findOne({
        where: { id, tenantId },
        include: [
          { model: PmsConnection, as: 'pmsConnection', include: [{ association: 'software', attributes: ['id', 'key', 'name'] }] },
          { model: CollectionStrategy, as: 'strategy', include: [{ model: CollectionStage, as: 'stages' }] },
        ],
        ...options,
      });
    } catch (error) {
      logger.error({ error, id }, 'Error finding automation');
      throw error;
    }
  },

  create: async (data, options = {}) => {
    try {
      const status = data.status ?? 'paused';
      return await CollectionAutomation.create(
        {
          ...data,
          status,
          startedAt: data.startedAt !== undefined ? data.startedAt : status === 'active' ? new Date() : null,
        },
        options
      );
    } catch (error) {
      logger.error({ error }, 'Error creating automation');
      throw error;
    }
  },

  update: async (id, tenantId, data, options = {}) => {
    try {
      const [count] = await CollectionAutomation.update(data, {
        where: { id, tenantId },
        ...options,
      });
      return count;
    } catch (error) {
      logger.error({ error, id }, 'Error updating automation');
      throw error;
    }
  },

  delete: async (id, tenantId, options = {}) => {
    try {
      const count = await CollectionAutomation.destroy({
        where: { id, tenantId },
        ...options,
      });
      return count;
    } catch (error) {
      logger.error({ error, id }, 'Error deleting automation');
      throw error;
    }
  },

  countCaseStates: async (automationId, whereExtra = {}, options = {}) => {
    try {
      const { tab, filters = {}, search, tenantId } = options;
      const statusArr = filters.status;
      const stageArr = filters.stage;
      const dpdMin = filters.dpdMin;
      const dpdMax = filters.dpdMax;
      const amountMinCents = filters.amountMinCents;
      const amountMaxCents = filters.amountMaxCents;
      let debtCaseWhere;
      let stateStatuses = ['active'];
      let searchDebtCaseIds = null;
      if (search && String(search).trim() && tenantId) {
        const q = `%${String(search).trim().replace(/%/g, '\\%')}%`;
        const [byDebtor, byLease, byUnit, byProperty] = await Promise.all([
          DebtCase.findAll({
            where: { tenantId },
            include: [{ model: Debtor, as: 'debtor', required: true, where: { fullName: { [Op.iLike]: q } }, attributes: [] }],
            attributes: ['id'],
            raw: true,
          }),
          DebtCase.findAll({
            where: { tenantId },
            include: [{ model: PmsLease, as: 'pmsLease', required: true, where: { leaseNumber: { [Op.iLike]: q } }, attributes: [] }],
            attributes: ['id'],
            raw: true,
          }),
          DebtCase.findAll({
            where: { tenantId },
            include: [{
              model: PmsLease,
              as: 'pmsLease',
              required: true,
              include: [{ model: PmsUnit, as: 'pmsUnit', required: true, where: { unitNumber: { [Op.iLike]: q } }, attributes: [] }],
              attributes: [],
            }],
            attributes: ['id'],
            raw: true,
          }),
          DebtCase.findAll({
            where: { tenantId },
            include: [{
              model: PmsLease,
              as: 'pmsLease',
              required: true,
              include: [{ model: PmsUnit, as: 'pmsUnit', required: true, include: [{ model: PmsProperty, as: 'pmsProperty', required: true, where: { name: { [Op.iLike]: q } }, attributes: [] }], attributes: [] }],
              attributes: [],
            }],
            attributes: ['id'],
            raw: true,
          }),
        ]);
        const allIds = [...byDebtor, ...byLease, ...byUnit, ...byProperty].map((r) => r.id).filter(Boolean);
        searchDebtCaseIds = [...new Set(allIds)];
      }

      if (statusArr && statusArr.length > 0) {
        const approvalOnly = statusArr.filter((s) => s !== 'IN_DISPUTE');
        const hasExcluded = approvalOnly.includes('EXCLUDED');
        if (hasExcluded) stateStatuses = ['active', 'closed'];
        if (approvalOnly.length > 0) {
          debtCaseWhere = { approvalStatus: { [Op.in]: approvalOnly } };
        }
        if (statusArr.includes('IN_DISPUTE') && approvalOnly.length === 0) {
          const seq = DebtCase.sequelize;
          debtCaseWhere = seq.literal(`"debt_cases"."id" IN (SELECT "debt_case_id" FROM "case_disputes" WHERE "status" = 'OPEN')`);
        } else if (statusArr.includes('IN_DISPUTE') && approvalOnly.length > 0) {
          const seq = DebtCase.sequelize;
          debtCaseWhere = {
            [Op.or]: [
              { approvalStatus: { [Op.in]: approvalOnly } },
              seq.literal(`"debt_cases"."id" IN (SELECT "debt_case_id" FROM "case_disputes" WHERE "status" = 'OPEN')`),
            ],
          };
        }
      } else if (tab === 'pending') {
        debtCaseWhere = { approvalStatus: 'PENDING_APPROVAL' };
      } else if (tab === 'active') {
        debtCaseWhere = { approvalStatus: 'APPROVED' };
      } else if (tab === 'excluded') {
        debtCaseWhere = { approvalStatus: 'EXCLUDED' };
        stateStatuses = ['active', 'closed'];
      }

      const extraWhere = {};
      if (dpdMin != null) extraWhere.daysPastDue = { ...extraWhere.daysPastDue, [Op.gte]: dpdMin };
      if (dpdMax != null) extraWhere.daysPastDue = { ...extraWhere.daysPastDue, [Op.lte]: dpdMax };
      if (amountMinCents != null) extraWhere.amountDueCents = { ...extraWhere.amountDueCents, [Op.gte]: amountMinCents };
      if (amountMaxCents != null) extraWhere.amountDueCents = { ...extraWhere.amountDueCents, [Op.lte]: amountMaxCents };
      if (Object.keys(extraWhere).length > 0) {
        debtCaseWhere = debtCaseWhere
          ? { [Op.and]: [debtCaseWhere, extraWhere] }
          : extraWhere;
      }

      const includeOpts = [];
      if (debtCaseWhere) {
        includeOpts.push({
          model: DebtCase,
          as: 'debtCase',
          required: true,
          where: debtCaseWhere,
        });
      }
      if (stageArr && stageArr.length > 0) {
        includeOpts.push({
          model: CollectionStage,
          as: 'currentStage',
          required: true,
          where: { name: { [Op.in]: stageArr } },
        });
      }

      const countWhere = { automationId, status: { [Op.in]: stateStatuses }, ...whereExtra };
      if (searchDebtCaseIds !== null) {
        if (searchDebtCaseIds.length === 0) return 0;
        countWhere.debtCaseId = { [Op.in]: searchDebtCaseIds };
      }
      return await CaseAutomationState.count({
        where: countWhere,
        include: includeOpts.length > 0 ? includeOpts : undefined,
        distinct: true,
        ...options,
      });
    } catch (error) {
      logger.error({ error, automationId }, 'Error counting case states');
      throw error;
    }
  },

  findCaseStates: async (automationId, options = {}) => {
    try {
      const { tab, filters = {}, search, tenantId } = options;
      const statusArr = filters.status;
      const stageArr = filters.stage;
      const dpdMin = filters.dpdMin;
      const dpdMax = filters.dpdMax;
      const amountMinCents = filters.amountMinCents;
      const amountMaxCents = filters.amountMaxCents;
      let debtCaseWhere;
      let stateStatuses = ['active'];
      let excludeDisputedFromApproved = false;
      let searchDebtCaseIds = null;
      if (search && String(search).trim() && tenantId) {
        const q = `%${String(search).trim().replace(/%/g, '\\%')}%`;
        const [byDebtor, byLease, byUnit, byProperty] = await Promise.all([
          DebtCase.findAll({
            where: { tenantId },
            include: [{ model: Debtor, as: 'debtor', required: true, where: { fullName: { [Op.iLike]: q } }, attributes: [] }],
            attributes: ['id'],
            raw: true,
          }),
          DebtCase.findAll({
            where: { tenantId },
            include: [{ model: PmsLease, as: 'pmsLease', required: true, where: { leaseNumber: { [Op.iLike]: q } }, attributes: [] }],
            attributes: ['id'],
            raw: true,
          }),
          DebtCase.findAll({
            where: { tenantId },
            include: [{
              model: PmsLease,
              as: 'pmsLease',
              required: true,
              include: [{ model: PmsUnit, as: 'pmsUnit', required: true, where: { unitNumber: { [Op.iLike]: q } }, attributes: [] }],
              attributes: [],
            }],
            attributes: ['id'],
            raw: true,
          }),
          DebtCase.findAll({
            where: { tenantId },
            include: [{
              model: PmsLease,
              as: 'pmsLease',
              required: true,
              include: [{ model: PmsUnit, as: 'pmsUnit', required: true, include: [{ model: PmsProperty, as: 'pmsProperty', required: true, where: { name: { [Op.iLike]: q } }, attributes: [] }], attributes: [] }],
              attributes: [],
            }],
            attributes: ['id'],
            raw: true,
          }),
        ]);
        const allIds = [...byDebtor, ...byLease, ...byUnit, ...byProperty].map((r) => r.id).filter(Boolean);
        searchDebtCaseIds = [...new Set(allIds)];
      }

      if (statusArr && statusArr.length > 0) {
        const approvalOnly = statusArr.filter((s) => s !== 'IN_DISPUTE');
        const hasExcluded = approvalOnly.includes('EXCLUDED');
        if (hasExcluded) stateStatuses = ['active', 'closed'];
        if (approvalOnly.length > 0) {
          debtCaseWhere = { approvalStatus: { [Op.in]: approvalOnly } };
        }
        if (statusArr.includes('IN_DISPUTE') && approvalOnly.length === 0) {
          const seq = DebtCase.sequelize;
          debtCaseWhere = seq.literal(`"debt_cases"."id" IN (SELECT "debt_case_id" FROM "case_disputes" WHERE "status" = 'OPEN')`);
        } else if (statusArr.includes('IN_DISPUTE') && approvalOnly.length > 0) {
          const seq = DebtCase.sequelize;
          debtCaseWhere = {
            [Op.or]: [
              { approvalStatus: { [Op.in]: approvalOnly } },
              seq.literal(`"debt_cases"."id" IN (SELECT "debt_case_id" FROM "case_disputes" WHERE "status" = 'OPEN')`),
            ],
          };
        }
        excludeDisputedFromApproved = approvalOnly.includes('APPROVED') && !statusArr.includes('IN_DISPUTE');
      } else if (tab === 'pending') {
        debtCaseWhere = { approvalStatus: 'PENDING_APPROVAL' };
      } else if (tab === 'active') {
        debtCaseWhere = { approvalStatus: 'APPROVED' };
        excludeDisputedFromApproved = true;
      } else if (tab === 'excluded') {
        debtCaseWhere = { approvalStatus: 'EXCLUDED' };
        stateStatuses = ['active', 'closed'];
      }

      const extraWhere = {};
      if (dpdMin != null) extraWhere.daysPastDue = { ...extraWhere.daysPastDue, [Op.gte]: dpdMin };
      if (dpdMax != null) extraWhere.daysPastDue = { ...extraWhere.daysPastDue, [Op.lte]: dpdMax };
      if (amountMinCents != null) extraWhere.amountDueCents = { ...extraWhere.amountDueCents, [Op.gte]: amountMinCents };
      if (amountMaxCents != null) extraWhere.amountDueCents = { ...extraWhere.amountDueCents, [Op.lte]: amountMaxCents };
      if (Object.keys(extraWhere).length > 0) {
        debtCaseWhere = debtCaseWhere
          ? { [Op.and]: [debtCaseWhere, extraWhere] }
          : extraWhere;
      }

      const currentStageInclude = {
        model: CollectionStage,
        as: 'currentStage',
        attributes: ['id', 'name', 'minDaysPastDue', 'maxDaysPastDue', 'channels'],
        required: stageArr && stageArr.length > 0,
        ...(stageArr && stageArr.length > 0 ? { where: { name: { [Op.in]: stageArr } } } : {}),
      };

      const { sortBy, sortOrder = 'ASC' } = options;
      let orderClause = options.order;
      if (!orderClause && sortBy) {
        if (sortBy === 'debtorName') {
          orderClause = [['debtCase', 'debtor', 'fullName', sortOrder]];
        } else if (sortBy === 'amountDueCents') {
          orderClause = [['debtCase', 'amountDueCents', sortOrder]];
        } else if (sortBy === 'daysPastDue') {
          orderClause = [['debtCase', 'daysPastDue', sortOrder]];
        } else if (sortBy === 'approvalStatus') {
          orderClause = [['debtCase', 'approvalStatus', sortOrder]];
        }
      }
      if (!orderClause) {
        orderClause = [
          ['nextActionAt', 'ASC'],
          ['lastAttemptAt', 'DESC'],
        ];
      }

      const mainWhere = { automationId, status: { [Op.in]: stateStatuses } };
      if (searchDebtCaseIds !== null) {
        if (searchDebtCaseIds.length === 0) return [];
        mainWhere.debtCaseId = { [Op.in]: searchDebtCaseIds };
      }
      const rows = await CaseAutomationState.findAll({
        where: mainWhere,
        include: [
          {
            model: DebtCase,
            as: 'debtCase',
            required: true,
            where: debtCaseWhere,
            include: [
              { model: Debtor, as: 'debtor', attributes: ['id', 'fullName', 'email', 'phone'] },
              {
                model: PmsLease,
                as: 'pmsLease',
                required: false,
                attributes: ['id', 'leaseNumber', 'status'],
                include: [
                  {
                    model: PmsUnit,
                    as: 'pmsUnit',
                    required: false,
                    attributes: ['id', 'unitNumber'],
                    include: [{ model: PmsProperty, as: 'pmsProperty', required: false, attributes: ['id', 'name'] }],
                  },
                ],
              },
            ],
          },
          currentStageInclude,
        ],
        order: orderClause,
        ...options,
      });

      if (excludeDisputedFromApproved && rows.length > 0) {
        const debtCaseIds = rows.map((r) => r.debtCaseId);
        const openDisputeIds = new Set(
          (await CaseDispute.findAll({
            where: { debtCaseId: { [Op.in]: debtCaseIds }, status: 'OPEN' },
            attributes: ['debtCaseId'],
            raw: true,
          })).map((r) => r.debt_case_id ?? r.debtCaseId)
        );
        return rows.filter((r) => !openDisputeIds.has(r.debtCaseId));
      }
      return rows;
    } catch (error) {
      logger.error({ error, automationId }, 'Error finding case states');
      throw error;
    }
  },

  findDisputesByAutomation: async (automationId, tenantId, options = {}) => {
    try {
      const enrolledIds = await automationRepository.findEnrolledDebtCaseIds(automationId);
      if (enrolledIds.length === 0) return [];

      return await CaseDispute.findAll({
        where: {
          tenantId,
          debtCaseId: { [Op.in]: enrolledIds },
          status: 'OPEN',
        },
        include: [
          {
            model: DebtCase,
            as: 'debtCase',
            required: true,
            include: [
              { model: Debtor, as: 'debtor', attributes: ['id', 'fullName', 'email', 'phone'] },
              {
                model: PmsLease,
                as: 'pmsLease',
                required: false,
                attributes: ['id', 'leaseNumber', 'status'],
                include: [
                  {
                    model: PmsUnit,
                    as: 'pmsUnit',
                    required: false,
                    attributes: ['id', 'unitNumber'],
                    include: [{ model: PmsProperty, as: 'pmsProperty', required: false, attributes: ['id', 'name'] }],
                  },
                ],
              },
            ],
          },
        ],
        order: [['openedAt', 'DESC']],
        ...options,
      });
    } catch (error) {
      logger.error({ error, automationId }, 'Error finding disputes for automation');
      throw error;
    }
  },

  findEvents: async (automationId, limit = 50, options = {}) => {
    try {
      const { dateFrom, dateTo, search, channels, eventTypes, stages } = options;
      const where = { automationId };

      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) where.createdAt[Op.gte] = new Date(dateFrom);
        if (dateTo) where.createdAt[Op.lte] = new Date(dateTo);
      }
      if (channels && channels.length > 0) {
        where.channel = { [Op.in]: channels.map((c) => String(c).toLowerCase()) };
      }
      if (eventTypes && eventTypes.length > 0) {
        where.eventType = { [Op.in]: eventTypes };
      }

      if (search && String(search).trim()) {
        const q = `%${String(search).trim().replace(/%/g, '\\%')}%`;
        const [byCase, byDebtor, byLease] = await Promise.all([
          DebtCase.findAll({ where: { casePublicId: { [Op.iLike]: q } }, attributes: ['id'], raw: true }),
          DebtCase.findAll({
            include: [{ model: Debtor, as: 'debtor', required: true, where: { [Op.or]: [{ fullName: { [Op.iLike]: q } }, { email: { [Op.iLike]: q } }, { phone: { [Op.iLike]: q } }] }, attributes: [] }],
            attributes: ['id'],
            raw: true,
          }),
          DebtCase.findAll({
            include: [{ model: PmsLease, as: 'pmsLease', required: true, where: { leaseNumber: { [Op.iLike]: q } }, attributes: [] }],
            attributes: ['id'],
            raw: true,
          }),
        ]);
        const allIds = [...byCase, ...byDebtor, ...byLease].map((r) => r.id).filter(Boolean);
        const debtCaseIdsFilter = [...new Set(allIds)];
        if (debtCaseIdsFilter.length === 0) return [];
        where.debtCaseId = { [Op.in]: debtCaseIdsFilter };
      }

      if (stages && stages.length > 0) {
        const auto = await CollectionAutomation.findByPk(automationId, { attributes: ['strategyId'] });
        if (!auto?.strategyId) return [];
        const stageRows = await CollectionStage.findAll({
          where: { strategyId: auto.strategyId, name: { [Op.in]: stages } },
          attributes: ['id'],
          raw: true,
        });
        const stageIds = stageRows.map((s) => s.id).filter(Boolean);
        if (stageIds.length === 0) return [];
        const states = await CaseAutomationState.findAll({
          where: { automationId, currentStageId: { [Op.in]: stageIds } },
          attributes: ['debtCaseId'],
          raw: true,
        });
        const caseIdsFromStages = [...new Set(states.map((s) => s.debtCaseId ?? s.debt_case_id).filter(Boolean))];
        if (caseIdsFromStages.length === 0) return [];
        if (where.debtCaseId) {
          const searchIds = where.debtCaseId[Op.in] || [];
          const intersection = searchIds.filter((id) => caseIdsFromStages.includes(id));
          where.debtCaseId = intersection.length ? { [Op.in]: intersection } : { [Op.in]: [] };
        } else {
          where.debtCaseId = { [Op.in]: caseIdsFromStages };
        }
      }

      const debtCaseInclude = {
        model: DebtCase,
        as: 'debtCase',
        required: false,
        attributes: ['id', 'casePublicId', 'amountDueCents', 'currency', 'daysPastDue', 'meta', 'approvalStatus'],
        include: [
          { model: Debtor, as: 'debtor', required: false, attributes: ['id', 'fullName', 'email', 'phone'] },
          { model: PmsLease, as: 'pmsLease', required: false, attributes: ['id', 'leaseNumber'] },
        ],
      };

      return await CollectionEvent.findAll({
        where,
        order: [['createdAt', 'DESC']],
        limit,
        include: [debtCaseInclude],
        ...options,
      });
    } catch (error) {
      logger.error({ error, automationId }, 'Error finding automation events');
      throw error;
    }
  },

  findCaseTimeline: async (automationId, debtCaseId) => {
    try {
      return await CollectionEvent.findAll({
        where: { automationId, debtCaseId },
        order: [['createdAt', 'ASC']],
        include: [
          {
            model: DebtCase,
            as: 'debtCase',
            required: false,
            attributes: ['id', 'casePublicId', 'amountDueCents', 'currency', 'daysPastDue', 'meta', 'approvalStatus'],
            include: [
              { model: Debtor, as: 'debtor', required: false, attributes: ['id', 'fullName', 'email', 'phone'] },
              { model: PmsLease, as: 'pmsLease', required: false, attributes: ['id', 'leaseNumber'] },
            ],
          },
        ],
      });
    } catch (error) {
      logger.error({ error, automationId, debtCaseId }, 'Error finding case timeline');
      throw error;
    }
  },

  getOverviewData: async (automationId, tenantId) => {
    try {
      const enrolledIds = await automationRepository.findEnrolledDebtCaseIds(automationId);

      const [total, pendingApproval, active, excluded, disputes, brokenAgreements, stageRows] = await Promise.all([
        CaseAutomationState.count({ where: { automationId } }),
        automationRepository.countCaseStates(automationId, {}, { tab: 'pending' }),
        automationRepository.countCaseStates(automationId, {}, { tab: 'active' }),
        automationRepository.countCaseStates(automationId, {}, { tab: 'excluded' }),
        enrolledIds.length === 0
          ? 0
          : CaseDispute.count({
              where: { tenantId, debtCaseId: { [Op.in]: enrolledIds }, status: 'OPEN' },
            }),
        enrolledIds.length === 0
          ? 0
          : PaymentAgreement.count({
              where: { tenantId, debtCaseId: { [Op.in]: enrolledIds }, status: 'BROKEN' },
            }),
        CaseAutomationState.findAll({
          where: { automationId, status: 'active' },
          attributes: ['currentStageId'],
          include: [
            {
              model: DebtCase,
              as: 'debtCase',
              required: true,
              attributes: ['amountDueCents', 'daysPastDue'],
            },
            { model: CollectionStage, as: 'currentStage', attributes: ['id', 'name'], required: false },
          ],
        }),
      ]);

      const MAX_CENTS_PER_CASE = 1e10; // ~$100M per case - cap to avoid overflow al sumar
      const MAX_TOTAL_CENTS = 1e12; // ~$10B total
      const safeCents = (v, max = MAX_CENTS_PER_CASE) => {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n)) return 0;
        return Math.min(Math.max(n, -max), max);
      };

      const stageMap = new Map();
      for (const row of stageRows || []) {
        const plain = row.get ? row.get({ plain: true }) : row;
        const stageId = plain.currentStageId ?? plain.current_stage_id;
        const stageName = plain.currentStage?.name ?? 'Unknown';
        const key = stageId ?? stageName;
        if (!stageMap.has(key)) {
          stageMap.set(key, { stageId, name: stageName, cases: 0, amount: 0, dpdSum: 0 });
        }
        const rec = stageMap.get(key);
        rec.cases += 1;
        rec.amount += safeCents(plain.debtCase?.amountDueCents ?? plain.debtCase?.amount_due_cents ?? 0);
        rec.dpdSum += safeCents(plain.debtCase?.daysPastDue ?? plain.debtCase?.days_past_due ?? 0);
      }
      const stages = [...stageMap.values()].map((s) => ({
        stageId: s.stageId,
        name: s.name,
        cases: s.cases,
        amount: safeCents(s.amount),
        avgDpd: s.cases > 0 ? Math.round(s.dpdSum / s.cases) : 0,
      }));

      const totalExposure = safeCents(
        stages.reduce((sum, s) => sum + (s.amount || 0), 0),
        MAX_TOTAL_CENTS
      );
      const highDpdCount = await CaseAutomationState.count({
        where: { automationId, status: 'active' },
        include: [
          {
            model: DebtCase,
            as: 'debtCase',
            required: true,
            where: { approvalStatus: 'APPROVED', daysPastDue: { [Op.gt]: 30 } },
            attributes: [],
          },
        ],
      });

      return {
        counts: {
          total,
          totalExposure,
          pendingApproval,
          active,
          excluded,
          disputes,
          brokenAgreements,
          highDpd: highDpdCount,
        },
        stages,
      };
    } catch (error) {
      logger.error({ error, automationId }, 'Error getting overview data');
      throw error;
    }
  },

  findEnrolledDebtCaseIds: async (automationId, options = {}) => {
    try {
      const rows = await CaseAutomationState.findAll({
        where: { automationId },
        attributes: ['debtCaseId'],
        raw: true,
        ...options,
      });
      return rows.map((r) => r.debt_case_id ?? r.debtCaseId);
    } catch (error) {
      logger.error({ error, automationId }, 'Error finding enrolled debt case ids');
      throw error;
    }
  },

  findAgreements: async (automationId, tenantId, options = {}) => {
    try {
      const debtCaseIds = await automationRepository.findEnrolledDebtCaseIds(automationId, options);
      if (debtCaseIds.length === 0) return [];

      const whereClause = { debtCaseId: { [Op.in]: debtCaseIds }, tenantId };
      const statuses = options.agreementStatuses;
      if (Array.isArray(statuses) && statuses.length > 0) {
        whereClause.status = { [Op.in]: statuses };
      }

      return await PaymentAgreement.findAll({
        where: whereClause,
        include: [
          {
            model: DebtCase,
            as: 'debtCase',
            required: true,
            attributes: ['id', 'amountDueCents', 'currency', 'status'],
            include: [{ model: Debtor, as: 'debtor', attributes: ['id', 'fullName', 'email', 'phone'] }],
          },
          {
            model: PaymentAgreementInstallment,
            as: 'installmentSchedule',
            required: false,
          },
        ],
        order: [['createdAt', 'DESC']],
        ...options,
      });
    } catch (error) {
      logger.error({ error, automationId }, 'Error finding automation agreements');
      throw error;
    }
  },
};
