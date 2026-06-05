import { Op } from 'sequelize';
import { DebtCase } from '../../models/index.js';

/** Cases that count toward Stripe metered usage and “active case” estimates. */
export function billableDebtCaseWhere(tenantId) {
  return {
    tenantId,
    mordecaiOperationalActive: true,
    closedAt: null,
    status: { [Op.ne]: 'PAID' },
  };
}

export async function countBillableDebtCases(tenantId) {
  return DebtCase.count({ where: billableDebtCaseWhere(tenantId) });
}
