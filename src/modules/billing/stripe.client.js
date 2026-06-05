import Stripe from 'stripe';

let stripe = null;

export const getStripeClient = () => {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('Missing STRIPE_SECRET_KEY');
  }
  stripe = new Stripe(key, {
    apiVersion: '2024-06-20',
    typescript: false,
  });
  return stripe;
};

