import { TRIAL_DURATION_DAYS, TRIAL_MAX_ACTIVE_CASES } from '../../config/billing.config.js';
import { ConflictError } from '../../errors/index.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeTrialEndsAt(fromDate = new Date()) {
  const start = fromDate instanceof Date ? fromDate : new Date(fromDate);
  return new Date(start.getTime() + TRIAL_DURATION_DAYS * MS_PER_DAY);
}

export function buildNewSubscriptionDefaults() {
  return {
    status: 'trialing',
    callsPlan: 'none',
    whiteLabelEnabled: false,
    extraSeats: 0,
    trialEndsAt: computeTrialEndsAt(new Date()),
  };
}

/**
 * Backfill trial_ends_at for legacy rows (pre-trial feature) still on DB-only trialing.
 */
export async function ensureTrialEndsAt(subscription) {
  if (!subscription || subscription.trialEndsAt || subscription.stripeSubscriptionId) {
    return subscription;
  }
  const anchor = subscription.createdAt ? new Date(subscription.createdAt) : new Date();
  await subscription.update({ trialEndsAt: computeTrialEndsAt(anchor) });
  return subscription;
}

export function isTrialExpired(subscription) {
  if (!subscription?.trialEndsAt) return false;
  return new Date(subscription.trialEndsAt).getTime() <= Date.now();
}

/** Free trial: no Stripe subscription yet, DB status trialing, trial window open. */
export function isOnFreeTrial(subscription) {
  if (!subscription || subscription.stripeSubscriptionId) return false;
  if (String(subscription.status || '').toLowerCase() !== 'trialing') return false;
  return !isTrialExpired(subscription);
}

export function getTrialSummary(subscription, activeCaseCount = 0) {
  const maxActiveCases = TRIAL_MAX_ACTIVE_CASES;
  const onFreeTrial = isOnFreeTrial(subscription);
  const expired =
    !subscription?.stripeSubscriptionId &&
    String(subscription?.status || '').toLowerCase() === 'trialing' &&
    isTrialExpired(subscription);
  const activeCases = Math.max(0, Number(activeCaseCount) || 0);
  const remainingActivations = onFreeTrial ? Math.max(0, maxActiveCases - activeCases) : 0;

  return {
    onFreeTrial,
    expired,
    endsAt: subscription?.trialEndsAt ?? null,
    maxActiveCases,
    activeCases,
    remainingActivations,
    durationDays: TRIAL_DURATION_DAYS,
  };
}

export function assertCanActivateOnTrial(subscription, billableCaseCount) {
  if (isOnFreeTrial(subscription)) {
    if (billableCaseCount >= TRIAL_MAX_ACTIVE_CASES) {
      throw new ConflictError(
        `Free trial allows up to ${TRIAL_MAX_ACTIVE_CASES} active cases. Subscribe in billing to activate more.`
      );
    }
    return;
  }

  if (
    !subscription?.stripeSubscriptionId &&
    String(subscription?.status || '').toLowerCase() === 'trialing' &&
    isTrialExpired(subscription)
  ) {
    throw new ConflictError(
      'Free trial has ended. Subscribe in billing to activate cases for Mordecai.'
    );
  }

  throw new ConflictError(
    'Subscribe and complete billing setup before activating cases for Mordecai.'
  );
}

export const billingTrialService = {
  computeTrialEndsAt,
  buildNewSubscriptionDefaults,
  ensureTrialEndsAt,
  isTrialExpired,
  isOnFreeTrial,
  getTrialSummary,
  assertCanActivateOnTrial,
};
