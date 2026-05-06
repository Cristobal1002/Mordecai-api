/**
 * Operational agreement lifecycle: one PENDING/ACTIVE per case, installment rows, agent context.
 */
import { Op } from 'sequelize';
import {
  PaymentAgreement,
  PaymentAgreementInstallment,
} from '../../models/index.js';
import { sequelize } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

export const OPERATIONAL_AGREEMENT_STATUSES = ['PENDING', 'ACTIVE'];

const addMonthsIsoDate = (dateOnlyStr, monthsToAdd) => {
  const s = String(dateOnlyStr || '').trim();
  if (!s) return null;
  const d = new Date(`${s}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + monthsToAdd);
  return d.toISOString().slice(0, 10);
};

const splitRemainingCents = (remainingCents, count) => {
  const n = Math.max(1, Math.trunc(count));
  const total = Math.max(0, Math.trunc(Number(remainingCents) || 0));
  const base = Math.floor(total / n);
  const extra = total % n;
  const amounts = [];
  for (let i = 0; i < n; i++) {
    amounts.push(base + (i < extra ? 1 : 0));
  }
  return amounts;
};

/**
 * Mark prior operational agreements as SUPERSEDED (renegotiation).
 */
export async function supersedeOperationalAgreementsForCase(
  tenantId,
  debtCaseId,
  { transaction } = {}
) {
  const [n] = await PaymentAgreement.update(
    { status: 'SUPERSEDED' },
    {
      where: {
        tenantId,
        debtCaseId,
        status: { [Op.in]: OPERATIONAL_AGREEMENT_STATUSES },
      },
      transaction,
    }
  );
  if (n > 0) {
    logger.info(
      { tenantId, debtCaseId, superseded: n },
      'Superseded prior operational payment agreements for case'
    );
  }
  return n;
}

/**
 * Insert installment schedule for a newly created agreement (same DB transaction as create).
 */
export async function createInstallmentRowsForAgreement(agreement, { transaction } = {}) {
  const tenantId = agreement.tenantId;
  const agreementId = agreement.id;
  const total = Math.max(0, Math.trunc(Number(agreement.totalAmountCents) || 0));
  const down = Math.max(0, Math.trunc(Number(agreement.downPaymentCents) || 0));
  const remaining = Math.max(0, total - down);

  if (agreement.type === 'PROMISE_TO_PAY') {
    const due =
      agreement.promiseDate ||
      agreement.startDate ||
      agreement.promise_date ||
      agreement.start_date;
    if (!due || remaining <= 0) return 0;
    await PaymentAgreementInstallment.create(
      {
        tenantId,
        agreementId,
        installmentNum: 1,
        dueDate: due,
        amountCents: remaining,
        status: 'PENDING',
      },
      { transaction }
    );
    return 1;
  }

  const n = Math.max(1, Math.trunc(Number(agreement.installments) || 1));
  const start =
    agreement.startDate || agreement.start_date || agreement.promiseDate || agreement.promise_date;
  if (!start || remaining <= 0) return 0;

  const amounts = splitRemainingCents(remaining, n);
  let created = 0;
  for (let i = 0; i < n; i++) {
    const due = addMonthsIsoDate(start, i);
    if (!due) break;
    const amt = amounts[i] ?? 0;
    if (amt <= 0) continue;
    // eslint-disable-next-line no-await-in-loop
    await PaymentAgreementInstallment.create(
      {
        tenantId,
        agreementId,
        installmentNum: i + 1,
        dueDate: due,
        amountCents: amt,
        status: 'PENDING',
      },
      { transaction }
    );
    created += 1;
  }
  return created;
}

export async function hasOperationalAgreementForCase(tenantId, debtCaseId) {
  const count = await PaymentAgreement.count({
    where: {
      tenantId,
      debtCaseId,
      status: { [Op.in]: OPERATIONAL_AGREEMENT_STATUSES },
    },
  });
  return count > 0;
}

/**
 * When PMS refresh shows a lower balance, treat the delta as payment applied to
 * pending installments (FIFO). Full payoff (new balance 0) marks all pending
 * installments paid and completes the agreement.
 */
export async function applyPmsBalanceDecreaseToInstallments({
  tenantId,
  debtCaseId,
  prevBalanceCents,
  newBalanceCents,
}) {
  const prev = Math.max(0, Math.trunc(Number(prevBalanceCents) || 0));
  const next = Math.max(0, Math.trunc(Number(newBalanceCents) || 0));
  if (prev <= next) {
    return { applied: 0, agreementCompleted: false };
  }

  const agreement = await PaymentAgreement.findOne({
    where: {
      tenantId,
      debtCaseId,
      status: { [Op.in]: ['ACTIVE', 'PENDING'] },
    },
    order: [['updatedAt', 'DESC']],
  });

  if (!agreement) {
    return { applied: 0, agreementCompleted: false };
  }

  const paidAt = new Date();

  if (next === 0) {
    const [n] = await PaymentAgreementInstallment.update(
      {
        status: 'PAID',
        paidAt,
        paidAmountCents: sequelize.literal('amount_cents'),
        source: 'pms_balance_sync',
      },
      {
        where: {
          agreementId: agreement.id,
          status: 'PENDING',
        },
      }
    );
    await agreement.update({ status: 'COMPLETED' });
    logger.info(
      {
        tenantId,
        debtCaseId,
        agreementId: agreement.id,
        installmentsMarkedPaid: n,
      },
      'Full payoff from PMS: marked pending installments PAID and completed agreement'
    );
    return { applied: n, agreementCompleted: true };
  }

  let pool = prev - next;
  const pending = await PaymentAgreementInstallment.findAll({
    where: { agreementId: agreement.id, status: 'PENDING' },
    order: [['installmentNum', 'ASC']],
  });

  let applied = 0;
  for (const row of pending) {
    if (pool <= 0) break;
    const amt = Math.trunc(Number(row.amountCents) || 0);
    if (amt <= 0) continue;
    if (pool >= amt) {
      // eslint-disable-next-line no-await-in-loop
      await row.update({
        status: 'PAID',
        paidAt,
        paidAmountCents: amt,
        source: 'pms_balance_sync',
      });
      pool -= amt;
      applied += 1;
    } else {
      break;
    }
  }

  const stillPending = await PaymentAgreementInstallment.count({
    where: { agreementId: agreement.id, status: 'PENDING' },
  });
  if (stillPending === 0) {
    await agreement.update({ status: 'COMPLETED' });
    logger.info(
      { tenantId, debtCaseId, agreementId: agreement.id },
      'All installments satisfied: agreement marked COMPLETED'
    );
    return { applied, agreementCompleted: true };
  }

  if (applied > 0) {
    logger.info(
      {
        tenantId,
        debtCaseId,
        agreementId: agreement.id,
        installmentsMarkedPaid: applied,
        remainingPoolCents: pool,
      },
      'Partial payment from PMS: applied balance delta to installment schedule'
    );
  }

  return { applied, agreementCompleted: false };
}

/**
 * Compact strings for ElevenLabs dynamic variables (follow-up call context).
 */
export async function buildAgreementContextDynamicVariables({
  tenantId,
  debtCaseId,
}) {
  const agreement = await PaymentAgreement.findOne({
    where: {
      tenantId,
      debtCaseId,
      status: {
        [Op.in]: [...OPERATIONAL_AGREEMENT_STATUSES, 'ACCEPTED'],
      },
    },
    order: [['updatedAt', 'DESC']],
    include: [
      {
        model: PaymentAgreementInstallment,
        as: 'installmentSchedule',
        required: false,
      },
    ],
  });

  if (!agreement) {
    return {
      has_active_agreement: '',
      agreement_status: '',
      agreement_type: '',
      agreement_summary: '',
      next_installment_due_date: '',
      next_installment_amount_cents: '',
      pending_installments_count: '',
    };
  }

  const plain = agreement.get ? agreement.get({ plain: true }) : agreement;
  const rows = (plain.installmentSchedule || []).slice().sort((a, b) => {
    const an = Number(a.installmentNum ?? a.installment_num);
    const bn = Number(b.installmentNum ?? b.installment_num);
    return an - bn;
  });

  const pending = rows.filter((r) => (r.status || 'PENDING') === 'PENDING');
  const next = pending[0];
  const nextDue = next?.dueDate || next?.due_date || '';
  const nextAmt = next
    ? String(next.amountCents ?? next.amount_cents ?? '')
    : '';

  const status = plain.status || '';
  const type = plain.type || '';
  const summaryParts = [
    `status=${status}`,
    `type=${type}`,
    nextDue ? `next_due=${nextDue}` : null,
    pending.length ? `pending_installments=${pending.length}` : null,
  ].filter(Boolean);

  return {
    has_active_agreement: 'true',
    agreement_status: String(status),
    agreement_type: String(type),
    agreement_summary: summaryParts.join('; ').slice(0, 500),
    next_installment_due_date: nextDue ? String(nextDue) : '',
    next_installment_amount_cents: nextAmt,
    pending_installments_count: pending.length ? String(pending.length) : '0',
  };
}
