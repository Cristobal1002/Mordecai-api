import { Op } from 'sequelize';
import { Tenant, TenantSubscription, TenantUser } from '../../models/index.js';
import { INCLUDED_SEATS } from '../../config/billing.config.js';
import {
  BILLING_PRICE_KEYS,
  StripePriceCatalogError,
  getBillingPriceId,
  getCallsPlanBillingKey,
  resolveStripeMode,
} from './stripe-price-catalog.service.js';
import { getStripeClient } from './stripe.client.js';
import { ConflictError, NotFoundError } from '../../errors/index.js';
import { buildNewSubscriptionDefaults } from './billing-trial.service.js';

const getPublishableKey = () => process.env.STRIPE_PUBLISHABLE_KEY?.trim() || '';

/**
 * Client secret for Payment Element (subscription first invoice PaymentIntent).
 */
const getSubscriptionPaymentClientSecret = async (stripe, subscription) => {
  let sub = subscription;
  if (!sub.latest_invoice || (typeof sub.latest_invoice === 'object' && !sub.latest_invoice.payment_intent)) {
    sub = await stripe.subscriptions.retrieve(subscription.id, {
      expand: ['latest_invoice.payment_intent'],
    });
  }
  const inv = sub.latest_invoice;
  if (!inv) {
    throw new ConflictError('No invoice on subscription yet; retry in a moment');
  }
  const invObj =
    typeof inv === 'object' && inv !== null && !Array.isArray(inv)
      ? inv
      : await stripe.invoices.retrieve(inv, { expand: ['payment_intent'] });
  let pi = invObj.payment_intent;
  if (typeof pi === 'string') {
    pi = await stripe.paymentIntents.retrieve(pi);
  }
  if (!pi?.client_secret) {
    throw new ConflictError(
      'No payment client secret (invoice may already be paid or require manual collection)',
    );
  }
  return { clientSecret: pi.client_secret, subscriptionId: sub.id };
};

const getBaseUrls = () => {
  const frontend =
    process.env.FRONTEND_APP_URL?.trim() ||
    process.env.PAYMENTS_BASE_URL?.trim() ||
    '';
  const api =
    process.env.API_PUBLIC_URL?.trim() ||
    process.env.PUBLIC_API_URL?.trim() ||
    '';
  return { frontend, api };
};

/** Test customer/sub IDs stored in DB are invisible when prod uses live Stripe keys. */
const isStripeMissingResource = (err) =>
  err?.code === 'resource_missing' ||
  err?.statusCode === 404 ||
  /no such (customer|subscription|price)/i.test(String(err?.message || ''));

const clearStripeBillingLinks = async (tenantId) => {
  await TenantSubscription.update(
    {
      stripeSubscriptionId: null,
      stripePlatformItemId: null,
      stripeUnitsItemId: null,
      stripeCallsItemId: null,
      stripeWlItemId: null,
      stripeSeatsItemId: null,
    },
    { where: { tenantId } },
  );
};

/**
 * Returns a customer id valid for the current Stripe mode (test/live).
 * Clears stale DB links when the stored customer only exists in the other mode.
 */
const resolveStripeCustomerId = async (stripe, tenant) => {
  const existingId = tenant.stripeCustomerId;
  if (!existingId) return null;
  try {
    await stripe.customers.retrieve(existingId);
    return existingId;
  } catch (err) {
    if (!isStripeMissingResource(err)) throw err;
    await tenant.update({ stripeCustomerId: null });
    await clearStripeBillingLinks(tenant.id);
    return null;
  }
};

const createStripeCustomerForTenant = async (stripe, tenant) => {
  const customer = await stripe.customers.create({
    name: tenant.name,
    metadata: { tenant_id: tenant.id },
  });
  await tenant.update({ stripeCustomerId: customer.id });
  return customer.id;
};

const ensureStripeCustomerId = async (stripe, tenant) => {
  const resolved = await resolveStripeCustomerId(stripe, tenant);
  if (resolved) return resolved;
  return createStripeCustomerForTenant(stripe, tenant);
};

/** Drop test-mode subscription ids that are invalid after switching to live keys. */
const reconcileStaleStripeSubscription = async (stripe, tenantId, sub) => {
  if (!sub.stripeSubscriptionId) return sub;
  try {
    await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    return sub;
  } catch (err) {
    if (!isStripeMissingResource(err)) throw err;
    await clearStripeBillingLinks(tenantId);
    return sub.reload();
  }
};

const requireTenantWithSubscription = async (tenantId) => {
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'name', 'stripeCustomerId'] });
  if (!tenant) throw new NotFoundError('Tenant');
  const [sub] = await TenantSubscription.findOrCreate({
    where: { tenantId },
    defaults: buildNewSubscriptionDefaults(),
  });
  const seats = await TenantUser.count({ where: { tenantId, status: 'active' } });
  return { tenant, sub, seats };
};

const buildSubscriptionItems = async ({ sub, seats, stripeMode }) => {
  const extraSeats = Math.max(0, Number(sub.extraSeats ?? 0));
  const seatsQty = Math.max(0, seats - INCLUDED_SEATS) + extraSeats;
  const callsKey = getCallsPlanBillingKey(sub.callsPlan);
  const itemSpecs = [
    { key: BILLING_PRICE_KEYS.PLATFORM_BASE, kind: 'platform' },
    { key: BILLING_PRICE_KEYS.PMS_UNITS_METERED, kind: 'units' },
    { key: callsKey, kind: 'calls' },
  ];
  if (sub.whiteLabelEnabled) itemSpecs.push({ key: BILLING_PRICE_KEYS.WHITE_LABEL, kind: 'wl' });
  if (seatsQty > 0) itemSpecs.push({ key: BILLING_PRICE_KEYS.SEAT_EXTRA, kind: 'seats', quantity: seatsQty });

  const items = [];
  for (const spec of itemSpecs) {
    // eslint-disable-next-line no-await-in-loop
    const price = await getBillingPriceId(spec.key, { stripeMode });
    items.push({
      price,
      ...(spec.quantity != null ? { quantity: spec.quantity } : null),
    });
  }
  return { items, seatsQty };
};

export const stripeBillingService = {
  /**
   * Create a Stripe Checkout URL to start subscription billing.
   * Stores/creates Stripe customer on tenant.
   */
  createCheckoutSession: async (tenantId) => {
    const stripe = getStripeClient();
    const stripeMode = resolveStripeMode();
    const { frontend } = getBaseUrls();
    if (!frontend) {
      throw new ConflictError('Missing FRONTEND_APP_URL or PAYMENTS_BASE_URL for checkout redirect');
    }

    let { tenant, sub, seats } = await requireTenantWithSubscription(tenantId);
    sub = await reconcileStaleStripeSubscription(stripe, tenantId, sub);
    if (sub.stripeSubscriptionId) {
      throw new ConflictError('Tenant already has an active Stripe subscription');
    }

    let customerId = await ensureStripeCustomerId(stripe, tenant);

    let items;
    try {
      ({ items } = await buildSubscriptionItems({ sub, seats, stripeMode }));
    } catch (err) {
      if (err instanceof StripePriceCatalogError) {
        throw new ConflictError(`Stripe price catalog is missing: ${err.message}`);
      }
      throw err;
    }

    const successUrl = `${frontend.replace(/\/+$/, '')}/settings/billing?stripe=success`;
    const cancelUrl = `${frontend.replace(/\/+$/, '')}/settings/billing?stripe=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: items.map((i) => ({ price: i.price, quantity: i.quantity ?? 1 })),
      allow_promotion_codes: false,
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: tenant.id,
      subscription_data: {
        metadata: { tenant_id: tenant.id },
      },
      metadata: { tenant_id: tenant.id, stripe_mode: stripeMode },
    });

    return { checkoutUrl: session.url };
  },

  /**
   * Embedded Payment Element: create or resume an incomplete subscription with the same line items as Checkout.
   * Returns clientSecret + publishable key for stripe.confirmPayment on the frontend.
   */
  createEmbeddedSubscriptionPayment: async (tenantId) => {
    const publishableKey = getPublishableKey();
    if (!publishableKey) {
      throw new ConflictError('Missing STRIPE_PUBLISHABLE_KEY (pk_test_... / pk_live_...)');
    }

    const stripe = getStripeClient();
    const stripeMode = resolveStripeMode();
    const { frontend } = getBaseUrls();
    if (!frontend) {
      throw new ConflictError('Missing FRONTEND_APP_URL or PAYMENTS_BASE_URL for return URL');
    }

    const returnUrl = `${frontend.replace(/\/+$/, '')}/settings/billing?stripe=success`;

    let { tenant, sub, seats } = await requireTenantWithSubscription(tenantId);
    sub = await reconcileStaleStripeSubscription(stripe, tenantId, sub);

    let items;
    try {
      ({ items } = await buildSubscriptionItems({ sub, seats, stripeMode }));
    } catch (err) {
      if (err instanceof StripePriceCatalogError) {
        throw new ConflictError(`Stripe price catalog is missing: ${err.message}`);
      }
      throw err;
    }

    let customerId = await ensureStripeCustomerId(stripe, tenant);

    const lineItems = items.map((i) => ({ price: i.price, quantity: i.quantity ?? 1 }));

    const createFreshSubscription = async () => {
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: lineItems,
        metadata: { tenant_id: tenant.id, stripe_mode: stripeMode },
        payment_behavior: 'default_incomplete',
        payment_settings: {
          save_default_payment_method: 'on_subscription',
        },
        expand: ['latest_invoice.payment_intent'],
      });
      return getSubscriptionPaymentClientSecret(stripe, subscription);
    };

    if (sub.stripeSubscriptionId) {
      let existing;
      try {
        existing = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId, {
          expand: ['latest_invoice.payment_intent'],
        });
      } catch (err) {
        if (!isStripeMissingResource(err)) throw err;
        await sub.update({ stripeSubscriptionId: null });
        await clearStripeBillingLinks(tenantId);
        const { clientSecret, subscriptionId } = await createFreshSubscription();
        return {
          clientSecret,
          publishableKey,
          subscriptionId,
          returnUrl,
          resumed: false,
        };
      }

      if (existing.status === 'active' || existing.status === 'trialing') {
        throw new ConflictError('Tenant already has an active Stripe subscription');
      }

      if (
        existing.status === 'incomplete' ||
        existing.status === 'past_due' ||
        existing.status === 'unpaid'
      ) {
        const { clientSecret, subscriptionId } = await getSubscriptionPaymentClientSecret(
          stripe,
          existing,
        );
        return {
          clientSecret,
          publishableKey,
          subscriptionId,
          returnUrl,
          resumed: true,
        };
      }

      if (existing.status !== 'canceled' && existing.status !== 'incomplete_expired') {
        throw new ConflictError(`Stripe subscription is in state ${existing.status}; use the billing portal or support`);
      }
    }

    const { clientSecret, subscriptionId } = await createFreshSubscription();
    return {
      clientSecret,
      publishableKey,
      subscriptionId,
      returnUrl,
      resumed: false,
    };
  },

  /**
   * Customer portal (manage payment method, invoices, cancel, etc.).
   */
  createPortalSession: async (tenantId) => {
    const stripe = getStripeClient();
    const { frontend } = getBaseUrls();
    if (!frontend) {
      throw new ConflictError('Missing FRONTEND_APP_URL or PAYMENTS_BASE_URL for portal redirect');
    }

    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'name', 'stripeCustomerId'] });
    if (!tenant) throw new NotFoundError('Tenant');

    const customerId = await resolveStripeCustomerId(stripe, tenant);
    if (!customerId) {
      throw new ConflictError(
        'Stripe billing is not linked in this environment (common after switching test → live). Use Subscribe in Billing to set up live billing.'
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${frontend.replace(/\/+$/, '')}/settings/billing`,
    });
    return { portalUrl: session.url };
  },

  /**
   * Sync local addon fields (calls plan, wl, seats) to Stripe subscription items.
   * Called after subscription is created and whenever the user updates add-ons.
   */
  syncSubscriptionItemsFromDb: async (tenantId) => {
    const stripe = getStripeClient();
    const stripeMode = resolveStripeMode();
    const { tenant, sub, seats } = await requireTenantWithSubscription(tenantId);
    if (!sub.stripeSubscriptionId) throw new ConflictError('Stripe subscription is not linked yet');

    const subscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId, {
      expand: ['items.data.price'],
    });

    const { items, seatsQty } = await buildSubscriptionItems({ sub, seats, stripeMode });
    const desiredPrices = new Set(items.map((i) => i.price));

    // Map current items by price id
    const current = subscription.items.data || [];
    const byPrice = new Map(current.map((it) => [it.price.id, it]));

    // Add / update
    for (const spec of items) {
      const existing = byPrice.get(spec.price);
      if (existing) {
        if (spec.quantity != null && existing.quantity !== spec.quantity) {
          // eslint-disable-next-line no-await-in-loop
          await stripe.subscriptionItems.update(existing.id, {
            quantity: spec.quantity,
            proration_behavior: 'create_prorations',
          });
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        await stripe.subscriptionItems.create({
          subscription: subscription.id,
          price: spec.price,
          quantity: spec.quantity ?? 1,
          proration_behavior: 'create_prorations',
        });
      }
    }

    // Remove items we no longer want (except metered units: keep it always if present)
    for (const it of current) {
      if (!desiredPrices.has(it.price.id)) {
        // eslint-disable-next-line no-await-in-loop
        await stripe.subscriptionItems.del(it.id, { proration_behavior: 'create_prorations' });
      }
    }

    // Refresh and store known item ids for usage reports
    const refreshed = await stripe.subscriptions.retrieve(subscription.id, { expand: ['items.data.price'] });
    const itemIds = refreshed.items.data || [];
    const priceToId = new Map(itemIds.map((it) => [it.price.id, it.id]));

    // Resolve which price belongs to which key
    const platformPrice = await getBillingPriceId(BILLING_PRICE_KEYS.PLATFORM_BASE, { stripeMode });
    const unitsPrice = await getBillingPriceId(BILLING_PRICE_KEYS.PMS_UNITS_METERED, { stripeMode });
    const callsPrice = await getBillingPriceId(getCallsPlanBillingKey(sub.callsPlan), { stripeMode });
    const wlPrice = sub.whiteLabelEnabled ? await getBillingPriceId(BILLING_PRICE_KEYS.WHITE_LABEL, { stripeMode }) : null;
    const seatsPrice = seatsQty > 0 ? await getBillingPriceId(BILLING_PRICE_KEYS.SEAT_EXTRA, { stripeMode }) : null;

    await sub.update({
      stripePlatformItemId: priceToId.get(platformPrice) || null,
      stripeUnitsItemId: priceToId.get(unitsPrice) || null,
      stripeCallsItemId: priceToId.get(callsPrice) || null,
      stripeWlItemId: wlPrice ? priceToId.get(wlPrice) || null : null,
      stripeSeatsItemId: seatsPrice ? priceToId.get(seatsPrice) || null : null,
      currentPeriodStart: refreshed.current_period_start ? new Date(refreshed.current_period_start * 1000) : sub.currentPeriodStart,
      currentPeriodEnd: refreshed.current_period_end ? new Date(refreshed.current_period_end * 1000) : sub.currentPeriodEnd,
    });

    await tenant.update({ stripeCustomerId: tenant.stripeCustomerId });
    return { ok: true };
  },
};

