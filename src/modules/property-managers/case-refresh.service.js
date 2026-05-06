/**
 * Refresh Existing Cases: UPDATE only financial/derived fields.
 * Does NOT touch: approval_status, last_contacted_at, next_action_at (except cooldown/close),
 * status (except RESOLVED when balance=0), meta history.
 */
import { Op } from 'sequelize';
import { ArBalance, ArCharge, DebtCase, PmsConnection } from '../../models/index.js';
import { applyPmsBalanceDecreaseToInstallments } from '../payment-agreements/payment-agreement-lifecycle.service.js';
import { logger } from '../../utils/logger.js';

const PAYMENT_COOLDOWN_MINUTES = Number(process.env.PAYMENT_COOLDOWN_MINUTES) || 1440; // 24h default

function computeDpdAndDueDate(chargesByLease, leaseId, todayTime) {
  const charges = chargesByLease.get(leaseId) ?? [];
  let best = null;
  for (const c of charges) {
    const openCents = Number(c.open_amount_cents ?? c.openAmountCents ?? c.amount_cents ?? c.amountCents ?? 0);
    if (openCents <= 0) continue;
    const due = c.due_date ?? c.dueDate;
    if (!due) continue;
    const dueTime = new Date(due).getTime();
    const dpd = Math.max(0, Math.floor((todayTime - dueTime) / (24 * 60 * 60 * 1000)));
    if (best == null || dpd > best.daysPastDue) {
      best = { daysPastDue: dpd, dueDate: due };
    }
  }
  return best ?? { daysPastDue: 0, dueDate: null };
}

export async function refreshCasesFromPms(tenantId, connectionId) {
  const now = new Date();
  const cooldownMs = PAYMENT_COOLDOWN_MINUTES * 60 * 1000;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayTime = today.getTime();

  const balances = await ArBalance.findAll({
    where: { tenantId, pmsConnectionId: connectionId },
    order: [['asOfDate', 'DESC']],
    raw: true,
  });
  const latestByLease = new Map();
  for (const b of balances) {
    if (!latestByLease.has(b.pms_lease_id)) {
      latestByLease.set(b.pms_lease_id, b);
    }
  }
  const leaseIds = [...latestByLease.keys()];
  if (leaseIds.length === 0) {
    return { updated: 0, resolved: 0, message: 'No lease balances to refresh.' };
  }

  const chargesRaw = await ArCharge.findAll({
    where: { pmsLeaseId: { [Op.in]: leaseIds }, pmsConnectionId: connectionId },
    attributes: ['pmsLeaseId', 'dueDate', 'openAmountCents', 'amountCents'],
    raw: true,
  });
  const chargesByLease = new Map();
  for (const c of chargesRaw) {
    const lid = c.pms_lease_id ?? c.pmsLeaseId;
    if (!chargesByLease.has(lid)) chargesByLease.set(lid, []);
    chargesByLease.get(lid).push(c);
  }

  const cases = await DebtCase.findAll({
    where: {
      tenantId,
      pmsLeaseId: { [Op.in]: leaseIds },
      approvalStatus: { [Op.ne]: 'EXCLUDED' },
      status: { [Op.notIn]: ['PAID'] },
    },
    attributes: ['id', 'pmsLeaseId', 'amountDueCents', 'status', 'nextActionAt'],
    raw: true,
  });

  let updated = 0;
  let resolved = 0;

  for (const dc of cases) {
    const leaseId = dc.pms_lease_id ?? dc.pmsLeaseId;
    const bal = latestByLease.get(leaseId);
    const newBalanceCents = bal
      ? Math.round(Number(bal.balance_cents ?? bal.balanceCents)) || 0
      : 0;
    const prevBalanceCents = Number(dc.amount_due_cents ?? dc.amountDueCents) || 0;

    const aging = computeDpdAndDueDate(chargesByLease, leaseId, todayTime);
    const currency = bal?.currency || 'USD';

    const updates = {
      amountDueCents: newBalanceCents,
      daysPastDue: aging.daysPastDue,
      dueDate: aging.dueDate || null,
      lastPmsSyncAt: now,
    };

    if (newBalanceCents <= 0) {
      updates.status = 'PAID';
      updates.closedAt = now;
      updates.nextActionAt = null;
      resolved++;
    } else if (newBalanceCents < prevBalanceCents && prevBalanceCents > 0) {
      updates.nextActionAt = new Date(Date.now() + cooldownMs);
    }
    // else: balance unchanged or increased, don't touch nextActionAt

    if (newBalanceCents < prevBalanceCents) {
      try {
        await applyPmsBalanceDecreaseToInstallments({
          tenantId,
          debtCaseId: dc.id,
          prevBalanceCents,
          newBalanceCents: newBalanceCents,
        });
      } catch (err) {
        logger.warn(
          { err, debtCaseId: dc.id, tenantId },
          'Could not sync payment agreement installments after PMS balance change'
        );
      }
    }

    await DebtCase.update(updates, { where: { id: dc.id } });
    updated++;
  }

  const connection = await PmsConnection.findByPk(connectionId, { attributes: ['id', 'syncState'] });
  if (connection) {
    const syncState = connection.syncState ?? {};
    await connection.update({
      syncState: {
        ...syncState,
        lastRefreshAt: now.toISOString(),
        lastRefreshStats: { updated, resolved },
        lastRunStatus: 'SUCCESS',
        lastErrorMessage: null,
      },
    });
  }

  return {
    updated,
    resolved,
    message: `Refreshed ${updated} case(s), ${resolved} resolved (balance=0).`,
  };
}
