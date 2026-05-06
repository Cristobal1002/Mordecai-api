/**
 * Dashboard overview service — KPIs financieros y operativos para CEO/CFO.
 * Fuentes: ar_payments, ar_aging_snapshots, payment_agreements, debt_cases, interaction_logs, collection_events.
 */
import { Op } from 'sequelize';
import { fn, col } from 'sequelize';
import {
  ArPayment,
  ArAgingSnapshot,
  PaymentAgreement,
  DebtCase,
  InteractionLog,
  CollectionEvent,
  PmsConnection,
} from '../../models/index.js';
import { literal } from 'sequelize';
import { tenantRepository } from '../tenants/tenant.repository.js';
import { NotFoundError } from '../../errors/index.js';

const RANGES = {
  last_7_days: 7,
  last_30_days: 30,
  mtd: null, // month-to-date, computed dynamically
};

function getDateRange(range, connectionId = null) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let startCurrent;
  let endCurrent = today;
  let startPrevious;
  let endPrevious;

  if (range === 'mtd') {
    startCurrent = new Date(today.getFullYear(), today.getMonth(), 1);
    const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    startPrevious = prevMonth;
    endPrevious = prevMonthEnd;
  } else {
    const days = RANGES[range] ?? 30;
    startCurrent = new Date(today);
    startCurrent.setDate(startCurrent.getDate() - days);
    endPrevious = new Date(startCurrent);
    endPrevious.setDate(endPrevious.getDate() - 1);
    startPrevious = new Date(endPrevious);
    startPrevious.setDate(startPrevious.getDate() - days + 1);
  }

  return {
    startCurrent: startCurrent.toISOString().slice(0, 10),
    endCurrent: endCurrent.toISOString().slice(0, 10),
    startPrevious: startPrevious.toISOString().slice(0, 10),
    endPrevious: endPrevious.toISOString().slice(0, 10),
    days: range === 'mtd' ? Math.ceil((endCurrent - startCurrent) / 86400000) : (RANGES[range] ?? 30),
  };
}

async function ensureTenant(tenantId) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw new NotFoundError('Tenant');
  return tenant;
}

export const dashboardService = {
  getOverview: async (tenantId, opts = {}) => {
    await ensureTenant(tenantId);
    const range = opts.range || 'last_30_days';
    const connectionId = opts.connectionId || null;

    const { startCurrent, endCurrent, startPrevious, endPrevious, days } = getDateRange(range);

    const where = { tenantId };
    const wherePayments = { tenantId };
    if (connectionId) {
      where.pmsConnectionId = connectionId;
      wherePayments.pmsConnectionId = connectionId;
    }

    // Recovered: payments from leases that are in our collection management (debt_cases with meta.pms_lease_id)
    const debtCasesWithLease = await DebtCase.findAll({
      where: {
        tenantId,
        [Op.and]: [literal("meta->>'pms_lease_id' IS NOT NULL AND meta->>'pms_lease_id' != ''")],
      },
      attributes: [[literal("(meta->>'pms_lease_id')::uuid"), 'pmsLeaseId']],
      raw: true,
    });
    const managedLeaseIds = debtCasesWithLease
      .map((dc) => dc.pmsLeaseId)
      .filter((id) => id != null);

    const recoveredWhere = {
      ...wherePayments,
      paidAt: { [Op.between]: [new Date(startCurrent + 'T00:00:00Z'), new Date(endCurrent + 'T23:59:59.999Z')] },
    };
    const recoveredPrevWhere = {
      ...wherePayments,
      paidAt: { [Op.between]: [new Date(startPrevious + 'T00:00:00Z'), new Date(endPrevious + 'T23:59:59.999Z')] },
    };
    if (managedLeaseIds.length > 0) {
      recoveredWhere.pmsLeaseId = { [Op.in]: managedLeaseIds };
      recoveredPrevWhere.pmsLeaseId = { [Op.in]: managedLeaseIds };
    } else {
      recoveredWhere.pmsLeaseId = { [Op.in]: [] };
      recoveredPrevWhere.pmsLeaseId = { [Op.in]: [] };
    }

    const [recoveredCurrent, recoveredPrevious, paymentsByDay, agingSnapshots, promised, agentStats, activity] =
      await Promise.all([
        ArPayment.sum('amountCents', { where: recoveredWhere }),
        ArPayment.sum('amountCents', { where: recoveredPrevWhere }),
        ArPayment.findAll({
          attributes: [
            [fn('date_trunc', 'day', col('paid_at')), 'date'],
            [fn('SUM', col('amount_cents')), 'totalCents'],
          ],
          where: recoveredWhere,
          group: [fn('date_trunc', 'day', col('paid_at'))],
          raw: true,
        }),
        ArAgingSnapshot.findAll({
          where,
          order: [['asOfDate', 'DESC']],
          attributes: ['asOfDate', 'totalCents', 'bucket030Cents', 'bucket3160Cents', 'bucket6190Cents', 'bucket90PlusCents'],
        }),
        PaymentAgreement.sum('totalAmountCents', {
          where: { tenantId, status: { [Op.in]: ['ACTIVE', 'ACCEPTED'] } },
        }),
        getAgentStats(tenantId, startCurrent, endCurrent),
        getActivityFeed(tenantId, 20),
      ]);

    const recoveredCents = Number(recoveredCurrent) || 0;
    const recoveredPrevCents = Number(recoveredPrevious) || 0;
    const promisedCents = Number(promised) || 0;

    const allSnapshots = agingSnapshots || [];
    const dates = [...new Set(allSnapshots.map((s) => s.asOfDate))].sort().reverse();
    const latestDate = dates[0];
    const previousDate = dates[1];
    const latestSnapshots = allSnapshots.filter((s) => s.asOfDate === latestDate);
    const previousSnapshots = allSnapshots.filter((s) => s.asOfDate === previousDate);

    const sumSnapshots = (snaps) =>
      (snaps || []).reduce(
        (acc, s) => ({
          totalCents: acc.totalCents + (Number(s.totalCents) || 0),
          bucket030Cents: acc.bucket030Cents + (Number(s.bucket030Cents) || 0),
          bucket3160Cents: acc.bucket3160Cents + (Number(s.bucket3160Cents) || 0),
          bucket6190Cents: acc.bucket6190Cents + (Number(s.bucket6190Cents) || 0),
          bucket90PlusCents: acc.bucket90PlusCents + (Number(s.bucket90PlusCents) || 0),
        }),
        { totalCents: 0, bucket030Cents: 0, bucket3160Cents: 0, bucket6190Cents: 0, bucket90PlusCents: 0 }
      );

    const latestAgingSum = sumSnapshots(latestSnapshots);
    const previousAgingSum = sumSnapshots(previousSnapshots);
    const delinquentCents = latestAgingSum.totalCents;

    const aging =
      latestSnapshots.length > 0
        ? {
            asOfDate: latestSnapshots[0].asOfDate,
            ...latestAgingSum,
          }
        : null;

    const agingPrevious =
      previousSnapshots.length > 0
        ? {
            totalCents: previousAgingSum.totalCents,
            bucket030Cents: previousAgingSum.bucket030Cents,
            bucket3160Cents: previousAgingSum.bucket3160Cents,
            bucket6190Cents: previousAgingSum.bucket6190Cents,
            bucket90PlusCents: previousAgingSum.bucket90PlusCents,
          }
        : null;

    const recoveredByDay = (paymentsByDay || []).map((r) => ({
      date: r.date ? (typeof r.date === 'string' ? r.date.slice(0, 10) : new Date(r.date).toISOString().slice(0, 10)) : null,
      totalCents: Number(r.totalCents) || 0,
    }));

    const deltaRecovered = recoveredPrevCents > 0 ? ((recoveredCents - recoveredPrevCents) / recoveredPrevCents) * 100 : (recoveredCents > 0 ? 100 : 0);
    const recoveryRate = delinquentCents > 0 ? (recoveredCents / delinquentCents) * 100 : 0;
    const fulfillmentPct = promisedCents > 0 ? (recoveredCents / promisedCents) * 100 : null;

    const lastSync = await PmsConnection.findOne({
      where: { tenantId, ...(connectionId ? { id: connectionId } : {}) },
      order: [['lastSyncedAt', 'DESC']],
      attributes: ['lastSyncedAt'],
    });

    return {
      range: { startCurrent, endCurrent, startPrevious, endPrevious, days },
      kpis: {
        recoveredCents,
        recoveredDeltaPct: Math.round(deltaRecovered * 10) / 10,
        promisedCents,
        fulfillmentPct: fulfillmentPct != null ? Math.round(fulfillmentPct * 10) / 10 : null,
        delinquentCents,
        recoveryRatePct: Math.round(recoveryRate * 10) / 10,
        agingDelta: agingPrevious
          ? {
              totalCents: aging.totalCents - agingPrevious.totalCents,
              bucket030Cents: aging.bucket030Cents - agingPrevious.bucket030Cents,
              bucket3160Cents: aging.bucket3160Cents - agingPrevious.bucket3160Cents,
              bucket6190Cents: aging.bucket6190Cents - agingPrevious.bucket6190Cents,
              bucket90PlusCents: aging.bucket90PlusCents - agingPrevious.bucket90PlusCents,
            }
          : null,
      },
      series: { recoveredByDay },
      aging,
      agent: agentStats,
      activity,
      lastSyncAt: lastSync?.lastSyncedAt ?? null,
    };
  },
};

async function getAgentStats(tenantId, startCurrent, endCurrent) {
  const start = new Date(startCurrent + 'T00:00:00Z');
  const end = new Date(endCurrent + 'T23:59:59.999Z');

  const [activeCases, contactedCases, reachedCount, agreementsCreated, closedPaid] = await Promise.all([
    DebtCase.count({ where: { tenantId, status: { [Op.in]: ['NEW', 'IN_PROGRESS', 'CONTACTED', 'PROMISE_TO_PAY', 'PAYMENT_PLAN'] } } }),
    DebtCase.count({
      where: {
        tenantId,
        lastContactedAt: { [Op.between]: [start, end] },
      },
    }),
    InteractionLog.count({
      where: {
        tenantId,
        outcome: 'CONNECTED',
        createdAt: { [Op.between]: [start, end] },
      },
    }),
    PaymentAgreement.count({
      where: {
        tenantId,
        status: { [Op.in]: ['ACTIVE', 'ACCEPTED', 'COMPLETED'] },
        createdAt: { [Op.between]: [start, end] },
      },
    }),
    DebtCase.count({
      where: {
        tenantId,
        status: 'PAID',
        closedAt: { [Op.between]: [start, end] },
      },
    }),
  ]);

  const closeRatePct = contactedCases > 0 ? Math.round((closedPaid / contactedCases) * 1000) / 10 : null;

  return {
    activeCases,
    contacted: contactedCases,
    reached: reachedCount,
    agreementsCreated,
    closedPaid,
    closeRatePct,
  };
}

async function getActivityFeed(tenantId, limit = 20) {
  const [interactions, events] = await Promise.all([
    InteractionLog.findAll({
      where: { tenantId },
      order: [['createdAt', 'DESC']],
      limit: Math.ceil(limit / 2),
      attributes: ['id', 'type', 'outcome', 'createdAt', 'debtCaseId'],
      raw: true,
    }),
    CollectionEvent.findAll({
      include: [{ association: 'automation', where: { tenantId }, required: true, attributes: [] }],
      order: [['createdAt', 'DESC']],
      limit: Math.ceil(limit / 2),
      attributes: ['id', 'eventType', 'channel', 'createdAt', 'debtCaseId'],
      raw: true,
    }),
  ]);

  const fromInteractions = (interactions || []).map((i) => ({
    id: i.id,
    eventType: i.outcome ? `call_${String(i.outcome).toLowerCase()}` : 'call',
    channel: (i.type && String(i.type).toLowerCase()) || 'call',
    createdAt: i.createdAt,
    debtCaseId: i.debtCaseId,
    source: 'interaction_log',
  }));

  const fromEvents = (events || []).map((e) => ({
    id: e.id,
    eventType: e.eventType || 'event',
    channel: e.channel || null,
    createdAt: e.createdAt,
    debtCaseId: e.debtCaseId,
    source: 'collection_event',
  }));

  const combined = [...fromInteractions, ...fromEvents].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return combined.slice(0, limit);
}
