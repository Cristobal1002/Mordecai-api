import {
  CaseAutomationState,
  CollectionStage,
  DebtCase,
  Debtor,
  Tenant,
} from '../../models/index.js';
import { sendCollectionSms } from '../twilio/sms/twilio.sms.service.js';

/**
 * Loads case + stage and sends the collection SMS (same path as the worker SMS_CASE job).
 */
export async function runSmsCaseDispatch({
  tenantId,
  caseId,
  automationId,
  stateId,
}) {
  const debtCase = await DebtCase.findOne({
    where: { id: caseId, tenantId },
    include: [{ model: Debtor, as: 'debtor' }],
  });
  if (!debtCase) throw new Error('Debt case not found');

  if (!debtCase.mordecaiOperationalActive) {
    return { caseId: debtCase.id, skipped: true, reason: 'case_not_operationally_active' };
  }

  let stage = null;
  if (stateId) {
    const state = await CaseAutomationState.findByPk(stateId, {
      include: [{ model: CollectionStage, as: 'currentStage' }],
    });
    stage = state?.currentStage || null;
  }

  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'name'] });

  return sendCollectionSms({
    tenantId,
    automationId,
    state: { debtCaseId: caseId, debtorId: debtCase.debtorId },
    debtCase,
    debtor: debtCase.debtor,
    stage,
    tenant,
  });
}
