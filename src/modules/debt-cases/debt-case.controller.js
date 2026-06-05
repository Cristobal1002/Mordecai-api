
import { debtCaseService } from './debt-case.service.js';

export const debtCaseController = {
    list: async (req, res, next) => {
        try {
            const { tenantId } = req.params;
            const { limit, offset } = req.query;

            const result = await debtCaseService.list(tenantId, { limit, offset });
            res.success(result);
        } catch (error) {
            next(error);
        }
    },

    getLogs: async (req, res, next) => {
        try {
            const { tenantId, caseId } = req.params;
            const result = await debtCaseService.getInteractionLogs(tenantId, caseId);
            res.success(result);
        } catch (error) {
            next(error);
        }
    },

    getPaymentInstructions: async (req, res, next) => {
        try {
            const { caseId } = req.params;
            const result = await debtCaseService.getPaymentInstructions(req, caseId);
            res.ok(result, 'Payment instructions retrieved successfully');
        } catch (error) {
            next(error);
        }
    },

    setMordecaiOperationalActive: async (req, res, next) => {
        try {
            const { tenantId, caseId } = req.params;
            const active = Boolean(req.body?.active);
            const result = await debtCaseService.setMordecaiOperationalActive(tenantId, caseId, active, req);
            res.ok(result, active ? 'Case activated for Mordecai' : 'Case paused in Mordecai');
        } catch (error) {
            next(error);
        }
    },
};
