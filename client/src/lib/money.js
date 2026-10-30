/**
 * Money is integer paise everywhere (D5). Parsing uses string/integer math only, never floats,
 * so "1499.90" can never become 149989.99999.
 */

/** "1499.5" -> 149950. Returns null when the text is not a valid amount (max 2 decimals). */
export function rupeesToPaise(input) {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(input ?? '').trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** 149950 -> "1499.50" (for form inputs). */
export function paiseToRupees(paise) {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

/** 149950 -> "₹1,499.50" (display only). */
export function formatINR(paise) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}
