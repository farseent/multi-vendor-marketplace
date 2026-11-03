/**
 * Rating maths for product aggregates (D61). Pure, so it can be property-tested.
 * `ratingAvg` is stored with 2 decimals (the API example shows 4.6; the extra digit keeps the
 * `-ratingAvg` sort from collapsing 4.64 and 4.55 into one value).
 */
export function ratingSummary(sum, count) {
  if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(count) || sum < 0 || count < 0) {
    throw new RangeError('Expected non-negative integers');
  }
  if (count === 0) return { ratingAvg: 0, ratingCount: 0 };
  return { ratingAvg: Math.round((sum * 100) / count) / 100, ratingCount: count };
}

/** "Asha Kumar" -> "Asha K." : public reviews never show a customer's full name. */
export function publicName(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'Customer';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${[...parts[parts.length - 1]][0].toUpperCase()}.`;
}
