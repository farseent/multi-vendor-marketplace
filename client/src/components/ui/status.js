// One place that decides which colour each status word gets, so "paid", "active" or "cancelled"
// look the same on every screen (storefront, vendor and admin).
const TONES = {
  success: [
    'active', 'approved', 'published', 'paid', 'delivered', 'completed', 'released', 'settled',
    'ok', 'up', 'enabled', 'good',
  ],
  warning: [
    'pending', 'pending_payment', 'draft', 'processing', 'pending_release', 'partial',
    'unpaid', 'degraded', 'not_eligible',
  ],
  info: ['shipped', 'placed', 'default'],
  danger: [
    'rejected', 'suspended', 'cancelled', 'failed', 'hidden', 'disabled', 'expired', 'reversed',
    'down', 'bad', 'full',
  ],
};

export function statusTone(status) {
  const key = String(status ?? '').toLowerCase();
  return Object.keys(TONES).find((tone) => TONES[tone].includes(key)) ?? 'neutral';
}

export const humanize = (value) => String(value ?? '').replaceAll('_', ' ');