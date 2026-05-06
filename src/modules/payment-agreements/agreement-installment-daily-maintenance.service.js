/**
 * Daily: D-1 installment reminders, then mark overdue installments MISSED,
 * then break ACTIVE agreements with any MISSED installment.
 */
import { Op } from 'sequelize';
import {
  PaymentAgreement,
  PaymentAgreementInstallment,
  CaseAutomationState,
  CollectionEvent,
} from '../../models/index.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_CALENDAR_TZ =
  process.env.AGREEMENT_INSTALLMENT_CALENDAR_TZ || 'America/Bogota';

/** Next calendar day YYYY-MM-DD from a civil date string in the given IANA timezone. */
function tomorrowYmdInTimeZone(timeZone) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map((x) => parseInt(x, 10));
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

async function runInstallmentDueTomorrowReminders(timeZone) {
  const tomorrowStr = tomorrowYmdInTimeZone(timeZone);

  const rows = await PaymentAgreementInstallment.findAll({
    where: { dueDate: tomorrowStr, status: 'PENDING' },
    include: [
      {
        model: PaymentAgreement,
        as: 'agreement',
        required: true,
        where: { status: 'ACTIVE' },
        attributes: ['id', 'tenantId', 'debtCaseId'],
      },
    ],
  });

  let collectionEvents = 0;
  for (const row of rows) {
    const debtCaseId = row.agreement.debtCaseId;
    const tenantId = row.agreement.tenantId;
    logger.info(
      {
        event: 'installment_reminder_d1',
        tenantId,
        debtCaseId,
        agreementId: row.agreementId,
        installmentId: row.id,
        installmentNum: row.installmentNum,
        dueDate: row.dueDate,
        amountCents: row.amountCents,
        calendarTz: timeZone,
      },
      'Installment due tomorrow (D-1 reminder)'
    );

    // eslint-disable-next-line no-await-in-loop
    const state = await CaseAutomationState.findOne({
      where: { debtCaseId, status: 'active' },
      attributes: ['automationId'],
    });
    if (state?.automationId) {
      // eslint-disable-next-line no-await-in-loop
      await CollectionEvent.create({
        automationId: state.automationId,
        debtCaseId,
        channel: 'system',
        eventType: 'installment_reminder_d1',
        payload: {
          agreementId: row.agreementId,
          installmentId: row.id,
          installmentNum: row.installmentNum,
          dueDate: row.dueDate,
          amountCents: row.amountCents,
        },
      });
      collectionEvents += 1;
    }
  }

  return {
    reminderCandidates: rows.length,
    collectionEvents,
    reminderForDueDate: tomorrowStr,
  };
}

export async function runAgreementInstallmentDailyMaintenance() {
  const tz = DEFAULT_CALENDAR_TZ;
  const reminderStats = await runInstallmentDueTomorrowReminders(tz);

  const today = new Date().toISOString().slice(0, 10);

  const [missedCount] = await PaymentAgreementInstallment.update(
    { status: 'MISSED' },
    {
      where: {
        status: 'PENDING',
        dueDate: { [Op.lt]: today },
      },
    }
  );

  const missedRows = await PaymentAgreementInstallment.findAll({
    where: { status: 'MISSED' },
    attributes: ['agreementId'],
    include: [
      {
        model: PaymentAgreement,
        as: 'agreement',
        required: true,
        attributes: ['id'],
        where: { status: 'ACTIVE' },
      },
    ],
  });

  const ids = [...new Set(missedRows.map((r) => r.agreementId))];
  let broken = 0;
  if (ids.length > 0) {
    const [n] = await PaymentAgreement.update(
      { status: 'BROKEN' },
      { where: { id: { [Op.in]: ids }, status: 'ACTIVE' } }
    );
    broken = n;
  }

  logger.info(
    {
      ...reminderStats,
      missedCount,
      brokenAgreements: broken,
      asOf: today,
    },
    'Agreement installment daily maintenance completed'
  );

  return {
    ...reminderStats,
    missedCount,
    brokenAgreements: broken,
    asOf: today,
  };
}
