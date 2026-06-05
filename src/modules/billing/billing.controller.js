import { billingService } from './billing.service.js';
import { tenantService } from '../tenants/tenant.service.js';
import { stripeBillingService } from './stripe-billing.service.js';

export const billingController = {
  getUsage: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      await tenantService.requireTenantAdmin(tenantId, req);
      const data = await billingService.getUsageSummary(tenantId);
      res.ok(data, 'Billing usage retrieved');
    } catch (error) {
      next(error);
    }
  },

  updateSubscription: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      await tenantService.requireTenantOwner(tenantId, req);
      const data = await billingService.updateSubscription(tenantId, req.body);
      res.ok(data, 'Subscription updated');
    } catch (error) {
      next(error);
    }
  },

  createCheckout: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      await tenantService.requireTenantOwner(tenantId, req);
      const data = await stripeBillingService.createCheckoutSession(tenantId);
      res.ok(data, 'Checkout session created');
    } catch (error) {
      next(error);
    }
  },

  createSubscribeIntent: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      await tenantService.requireTenantOwner(tenantId, req);
      const data = await stripeBillingService.createEmbeddedSubscriptionPayment(tenantId);
      res.ok(data, 'Subscription payment intent ready');
    } catch (error) {
      next(error);
    }
  },

  createPortal: async (req, res, next) => {
    try {
      const { tenantId } = req.params;
      await tenantService.requireTenantOwner(tenantId, req);
      const data = await stripeBillingService.createPortalSession(tenantId);
      res.ok(data, 'Billing portal session created');
    } catch (error) {
      next(error);
    }
  },
};
