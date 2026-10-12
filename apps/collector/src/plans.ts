/** Plan names, prices and quotas. Pricing is the owner's call; change it only when he says so. */
export const PLANS = {
  starter: { name: 'Starter', price: 149, quota: 200 },
  pro: { name: 'Pro', price: 299, quota: 600 },
} as const;
export type PlanId = keyof typeof PLANS;
export const APP_NAME = 'Yardsign';
