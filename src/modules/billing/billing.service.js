import { Tenant, TenantSubscription, PmsUnit, TenantUser } from '../../models/index.js';
import { countBillableDebtCases } from './billable-debt-cases.js';
import { billingTrialService, buildNewSubscriptionDefaults } from './billing-trial.service.js';
import {
  BILLING_ESTIMATE_MODE,
  MINIMUM_MONTHLY_CENTS,
  CALLS_PLAN_CENTS,
  WHITE_LABEL_CENTS,
  EXTRA_SEAT_CENTS,
  INCLUDED_SEATS,
  STRIPE_METERED_INCLUDED_UNITS,
  STRIPE_METERED_RATE_CENTS,
} from '../../config/billing.config.js';

/**
 * Stripe-aligned: fixed platform minimum + metered overage above included units (see worker usage report).
 * @private
 */
function calculateBillStripe({
  unitCount,
  callsPlanCents,
  whiteLabelCents,
  seatsCents,
}) {
  const includedCap = Math.max(0, STRIPE_METERED_INCLUDED_UNITS);
  const rate = Math.max(0, STRIPE_METERED_RATE_CENTS);
  const overage = Math.max(0, unitCount - includedCap);
  const meteredCents = overage * rate;
  const baseCents = MINIMUM_MONTHLY_CENTS + meteredCents;

  const tiers = [];
  if (unitCount > 0 && includedCap > 0) {
    const includedRowUnits = Math.min(unitCount, includedCap);
    tiers.push({
      label: `Included active cases (first ${includedCap})`,
      units: includedRowUnits,
      rateCents: 0,
      subtotalCents: 0,
    });
  }
  if (overage > 0 && rate > 0) {
    tiers.push({
      label: 'Active cases (metered overage)',
      units: overage,
      rateCents: rate,
      subtotalCents: meteredCents,
    });
  }

  const checkoutStyleSubtotalCents =
    MINIMUM_MONTHLY_CENTS +
    callsPlanCents +
    whiteLabelCents +
    seatsCents +
    (overage > 0 ? rate : 0);

  return {
    unitCount,
    baseCents,
    minimumApplied: false,
    tiers: tiers.filter((t) => t.units > 0),
    callsPlanCents,
    whiteLabelCents,
    seatsCents,
    totalCents: baseCents + callsPlanCents + whiteLabelCents + seatsCents,
    pricingModel: 'stripe',
    stripeBreakdown: {
      platformBaseCents: MINIMUM_MONTHLY_CENTS,
      includedPmsUnits: includedCap,
      meteredOverageUnits: overage,
      meteredRateCents: rate,
      meteredSubtotalCents: meteredCents,
      /**
       * Stripe Checkout often adds only the metered *unit amount* to the on-page subtotal,
       * not quantity × usage. Matches “$300 + $1.50 + add-ons” style totals before invoicing.
       */
      checkoutStyleSubtotalCents,
    },
  };
}

/**
 * Lógica interna de cálculo de factura.
 * Si customRatePerUnitCents tiene valor, usa rate flat para todas las unidades.
 * @private
 */
function calculateBill({
  unitCount,
  callsPlan,
  whiteLabelEnabled,
  extraSeats,
  customRatePerUnitCents,
}) {
  const callsPlanCents = CALLS_PLAN_CENTS[callsPlan] ?? CALLS_PLAN_CENTS.none;
  const whiteLabelCents = whiteLabelEnabled ? WHITE_LABEL_CENTS : 0;
  const seatsCents = Math.max(0, extraSeats) * EXTRA_SEAT_CENTS;

  if (
    BILLING_ESTIMATE_MODE === 'stripe' &&
    (customRatePerUnitCents == null || customRatePerUnitCents <= 0)
  ) {
    return calculateBillStripe({
      unitCount,
      callsPlanCents,
      whiteLabelCents,
      seatsCents,
    });
  }

  let baseCents;
  let minimumApplied = false;
  let tiers = [];

  if (customRatePerUnitCents != null && customRatePerUnitCents > 0) {
    baseCents = unitCount * customRatePerUnitCents;
    baseCents = Math.max(baseCents, MINIMUM_MONTHLY_CENTS);
    if (baseCents === MINIMUM_MONTHLY_CENTS && unitCount > 0) {
      minimumApplied = true;
    }
    tiers = [
      {
        label: 'Custom rate',
        units: unitCount,
        rateCents: customRatePerUnitCents,
        subtotalCents: unitCount * customRatePerUnitCents,
      },
    ].filter((t) => t.units > 0);
  } else {
    const tier1 = Math.min(unitCount, 500);
    const tier2 = Math.max(0, Math.min(unitCount - 500, 1000));
    const tier3 = Math.max(0, Math.min(unitCount - 1500, 3500));
    const tier4 = Math.max(0, unitCount - 5000);

    const rawBase =
      tier1 * 150 + tier2 * 125 + tier3 * 100 + tier4 * 90;
    baseCents = Math.max(rawBase, MINIMUM_MONTHLY_CENTS);
    minimumApplied = rawBase < MINIMUM_MONTHLY_CENTS;

    tiers = [
      { label: 'First 500 units', units: tier1, rateCents: 150, subtotalCents: tier1 * 150 },
      { label: 'Units 501–1,500', units: tier2, rateCents: 125, subtotalCents: tier2 * 125 },
      { label: 'Units 1,501–5,000', units: tier3, rateCents: 100, subtotalCents: tier3 * 100 },
      { label: 'Units 5,000+', units: tier4, rateCents: 90, subtotalCents: tier4 * 90 },
    ].filter((t) => t.units > 0);
  }

  const totalCents = baseCents + callsPlanCents + whiteLabelCents + seatsCents;

  return {
    unitCount,
    baseCents,
    minimumApplied,
    tiers,
    callsPlanCents,
    whiteLabelCents,
    seatsCents,
    totalCents,
    pricingModel: 'tiers',
    stripeBreakdown: null,
  };
}

export const billingService = {
  getUsageSummary: async (tenantId) => {
    const [billableCaseCount, pmsUnitCount] = await Promise.all([
      countBillableDebtCases(tenantId),
      PmsUnit.count({ where: { tenantId } }),
    ]);
    const unitCountVal = billableCaseCount;

    const currentSeats = await TenantUser.count({
      where: { tenantId, status: 'active' },
    });

    const [subscription] = await TenantSubscription.findOrCreate({
      where: { tenantId },
      defaults: buildNewSubscriptionDefaults(),
    });
    await billingTrialService.ensureTrialEndsAt(subscription);

    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'stripeCustomerId'] });

    const bill = calculateBill({
      unitCount: unitCountVal,
      callsPlan: subscription.callsPlan ?? 'none',
      whiteLabelEnabled: subscription.whiteLabelEnabled ?? false,
      extraSeats: subscription.extraSeats ?? 0,
      customRatePerUnitCents: subscription.customRatePerUnitCents,
    });

    const trial = billingTrialService.getTrialSummary(subscription, unitCountVal);

    return {
      unitCount: unitCountVal,
      pmsUnitCount,
      currentSeats,
      includedSeats: INCLUDED_SEATS,
      extraSeats: subscription.extraSeats ?? 0,
      stripeCustomerId: tenant?.stripeCustomerId ?? null,
      subscription: {
        callsPlan: subscription.callsPlan ?? 'none',
        whiteLabelEnabled: subscription.whiteLabelEnabled ?? false,
        extraSeats: subscription.extraSeats ?? 0,
        status: subscription.status ?? 'trialing',
        trialEndsAt: subscription.trialEndsAt,
        stripeSubscriptionId: subscription.stripeSubscriptionId ?? null,
      },
      trial,
      bill,
    };
  },

  updateSubscription: async (tenantId, data) => {
    const existing = await TenantSubscription.findOne({
      where: { tenantId },
    });

    const updates = {};
    if (data.callsPlan !== undefined) updates.callsPlan = data.callsPlan;
    if (data.whiteLabelEnabled !== undefined) updates.whiteLabelEnabled = data.whiteLabelEnabled;
    if (data.extraSeats !== undefined) updates.extraSeats = Math.max(0, data.extraSeats);
    if (data.status !== undefined) updates.status = data.status;
    if (data.notes !== undefined) updates.notes = data.notes;

    let row;
    if (existing) {
      row = await existing.update(updates);
    } else {
      row = await TenantSubscription.create({
        tenantId,
        ...updates,
      });
    }

    // If Stripe subscription exists, keep Stripe items in sync with add-ons.
    if (row?.stripeSubscriptionId) {
      try {
        const { stripeBillingService } = await import('./stripe-billing.service.js');
        await stripeBillingService.syncSubscriptionItemsFromDb(tenantId);
      } catch (_err) {
        // Non-fatal: UI can still show updated config; Stripe sync is retried via webhook/ops.
      }
    }

    return billingService.getUsageSummary(tenantId);
  },
};
