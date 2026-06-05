
import { DebtCase, InteractionLog, Debtor, FlowPolicy, TenantUser, TenantSubscription } from '../../models/index.js';
import { NotFoundError, ForbiddenError, ConflictError } from '../../errors/index.js';
import { countBillableDebtCases } from '../billing/billable-debt-cases.js';
import { billingTrialService } from '../billing/billing-trial.service.js';
import { buildPaymentInstructions } from '../pay/payment-instructions.service.js';
import { getAuthIdentity } from '../../utils/auth-identity.js';
import { userService } from '../users/user.service.js';
import { tenantService } from '../tenants/tenant.service.js';

export const debtCaseService = {
    list: async (tenantId, params = {}) => {
        const limit = params.limit || 50;
        const offset = params.offset || 0;

        return await DebtCase.findAndCountAll({
            where: { tenantId },
            include: [
                { model: Debtor },
                { model: FlowPolicy, as: 'flowPolicy' }
            ],
            limit,
            offset,
            order: [['updatedAt', 'DESC']]
        });
    },

    getInteractionLogs: async (tenantId, caseId) => {
        const debtCase = await DebtCase.findOne({ where: { id: caseId, tenantId } });
        if (!debtCase) throw new NotFoundError('DebtCase');

        return await InteractionLog.findAll({
            where: { debtCaseId: caseId },
            order: [['createdAt', 'DESC']]
        });
    },

    getPaymentInstructions: async (req, caseId) => {
        const debtCase = await DebtCase.findOne({
            where: { id: caseId },
            include: [{ model: Debtor, as: 'debtor', attributes: ['id'] }],
        });
        if (!debtCase) throw new NotFoundError('DebtCase');

        const identity = getAuthIdentity(req);
        const user = await userService.getUserByAuth(identity) ?? await userService.findByEmail(identity.email);
        if (!user) throw new ForbiddenError('User not found');

        const membership = await TenantUser.findOne({
            where: { userId: user.id, tenantId: debtCase.tenantId, status: 'active' },
        });
        if (!membership) throw new ForbiddenError('You do not have access to this case');

        const meta = debtCase.meta || {};
        const pmsLeaseId = meta.pms_lease_id ?? meta.pmsLeaseId ?? null;

        return await buildPaymentInstructions({
            tenantId: debtCase.tenantId,
            debtCaseId: debtCase.id,
            casePublicId: debtCase.casePublicId ?? null,
            debtorId: debtCase.debtorId,
            pmsLeaseId,
        });
    },

    setMordecaiOperationalActive: async (tenantId, caseId, active, req) => {
        await tenantService.requireTenantAdmin(tenantId, req);
        const debtCase = await DebtCase.findOne({ where: { id: caseId, tenantId } });
        if (!debtCase) throw new NotFoundError('DebtCase');

        if (active === true && !debtCase.mordecaiOperationalActive) {
            const sub = await TenantSubscription.findOne({ where: { tenantId } });
            if (!sub) {
                throw new ConflictError(
                    'Subscribe and complete billing setup before activating cases for Mordecai.'
                );
            }
            await billingTrialService.ensureTrialEndsAt(sub);

            if (sub.stripeSubscriptionId) {
                const st = String(sub.status || '').toLowerCase();
                if (!['active', 'trialing'].includes(st)) {
                    throw new ConflictError('Subscription must be active or trialing to activate cases.');
                }
            } else {
                const billableCount = await countBillableDebtCases(tenantId);
                billingTrialService.assertCanActivateOnTrial(sub, billableCount);
            }
        }

        await debtCase.update({ mordecaiOperationalActive: active });
        const plain = debtCase.get({ plain: true });
        return {
            id: plain.id,
            tenantId: plain.tenantId,
            mordecaiOperationalActive: plain.mordecaiOperationalActive,
        };
    },
};
