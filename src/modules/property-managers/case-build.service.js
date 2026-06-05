/**
 * Build New Cases: INSERT only. Creates debt_cases for leases with balance that don't exist yet.
 * Idempotent: uses external_key to avoid duplicates. Does NOT update existing cases.
 */
import { Op } from 'sequelize';
import {
  ArBalance,
  ArCharge,
  PmsLease,
  PmsDebtor,
  PmsProperty,
  PmsUnit,
  Debtor,
  DebtCase,
  PmsConnection,
} from '../../models/index.js';
import { automationService } from '../automations/automation.service.js';
import { logger } from '../../utils/logger.js';
import { formatSingleLineMailingAddress } from '../../utils/mailing-address.js';

const buildExternalKey = (connectionId, leaseId) =>
  `pms:${connectionId}:lease:${leaseId}`;

/**
 * Compute days past due per lease from oldest unpaid charge.
 */
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

export async function buildNewCasesFromPms(tenantId, connectionId) {
  const balances = await ArBalance.findAll({
    where: {
      tenantId,
      pmsConnectionId: connectionId,
      balanceCents: { [Op.gt]: 0 },
    },
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
    return {
      created: 0,
      message: 'No leases with balance > 0. Run PMS Sync first.',
    };
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayTime = today.getTime();
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

  const leases = await PmsLease.findAll({
    where: { id: { [Op.in]: leaseIds } },
    include: [
      { model: PmsDebtor, as: 'pmsDebtor', required: true },
      { model: PmsProperty, as: 'pmsProperty', required: false },
      { model: PmsUnit, as: 'pmsUnit', required: false },
    ],
  });

  const prefix = `pms:${connectionId}:lease:`;
  const existingRows = await DebtCase.findAll({
    where: {
      tenantId,
      externalKey: { [Op.like]: `${prefix}%` },
    },
    attributes: ['externalKey'],
    raw: true,
  });
  const existingKeys = new Set(existingRows.map((r) => r.external_key ?? r.externalKey));

  const debtorCache = new Map();
  let created = 0;

  for (const lease of leases) {
    const pmsDebtor = lease.pmsDebtor;
    if (!pmsDebtor) continue;
    const bal = latestByLease.get(lease.id);
    if (!bal || Number(bal.balance_cents ?? bal.balanceCents) <= 0) continue;

    const externalKey = buildExternalKey(connectionId, lease.id);
    if (existingKeys.has(externalKey)) continue;

    let debtor = debtorCache.get(pmsDebtor.id);
    const debtorAddress = formatSingleLineMailingAddress(pmsDebtor.address);
    if (!debtor) {
      const externalRef = `pms:${connectionId}:${pmsDebtor.externalId}`;
      const [d] = await Debtor.findOrCreate({
        where: { tenantId, externalRef },
        defaults: {
          tenantId,
          externalRef,
          fullName: pmsDebtor.displayName || 'Unknown',
          email: pmsDebtor.email ?? null,
          phone: pmsDebtor.phone ?? null,
          metadata: {
            pms_debtor_id: pmsDebtor.id,
            ...(debtorAddress ? { mailing_address_single_line: debtorAddress } : {}),
          },
        },
      });
      debtor = d;
      debtorCache.set(pmsDebtor.id, debtor);
    }

    const rawCents = bal.balance_cents ?? bal.balanceCents ?? 0;
    const amountDueCents = Math.round(Number(rawCents)) || 0;
    if (amountDueCents <= 0 || !Number.isFinite(amountDueCents)) continue;

    const aging = computeDpdAndDueDate(chargesByLease, lease.id, todayTime);
    const propertyAddress = formatSingleLineMailingAddress(lease.pmsProperty?.address);
    const meta = {
      source: 'pms',
      pms_connection_id: connectionId,
      pms_lease_id: lease.id,
      pms_debtor_id: pmsDebtor.id,
      lease_number: lease.leaseNumber ?? lease.externalId ?? null,
      property_name: lease.pmsProperty?.name ?? null,
      property_address: propertyAddress || null,
      debtor_address: debtorAddress || null,
      unit_number: lease.pmsUnit?.unitNumber ?? null,
    };

    try {
      await DebtCase.create({
        tenantId,
        debtorId: debtor.id,
        pmsLeaseId: lease.id,
        externalKey,
        amountDueCents,
        currency: bal.currency || 'USD',
        daysPastDue: aging.daysPastDue,
        dueDate: aging.dueDate || undefined,
        status: 'NEW',
        mordecaiOperationalActive: false,
        nextActionAt: new Date(),
        meta,
      });
      created++;
      existingKeys.add(externalKey);
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        existingKeys.add(externalKey);
        continue;
      }
      throw err;
    }
  }

  const connection = await PmsConnection.findByPk(connectionId, { attributes: ['id', 'syncState'] });
  if (connection) {
    const syncState = connection.syncState ?? {};
    await connection.update({
      syncState: {
        ...syncState,
        lastBuildAt: new Date().toISOString(),
        lastBuildStats: { created },
        lastRunStatus: 'SUCCESS',
        lastErrorMessage: null,
      },
    });
  }

  if (created > 0) {
    try {
      const automations = await automationService.list(tenantId, connectionId);
      for (const a of automations) {
        if (a.status !== 'active') continue;
        try {
          await automationService.enroll(tenantId, a.id, {});
        } catch (err) {
          logger.warn({ err, automationId: a.id }, 'Auto-enroll after build-new-cases failed');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'List automations for auto-enroll failed');
    }
  }

  return {
    created,
    message: created > 0 ? `Created ${created} new case(s).` : 'No new cases to create.',
  };
}
