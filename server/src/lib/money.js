/**
 * Integer-paise helpers (D5). Everything here is exact: products are done with BigInt so a large
 * amount can never lose precision, and results are plain Numbers again.
 */

/** roundHalfUp(a * b / c) for non-negative integers. e.g. 10% of 12345 = mulDiv(12345, 10, 100). */
export function mulDivRoundHalfUp(a, b, c) {
  for (const n of [a, b, c]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Expected non-negative integers');
  }
  if (c === 0) throw new RangeError('Division by zero');
  const [A, B, C] = [BigInt(a), BigInt(b), BigInt(c)];
  return Number((2n * A * B + C) / (2n * C)); // floor((2ab + c) / 2c) == round half up
}

/**
 * Splits `total` across `weights` in proportion to each weight, using the largest-remainder
 * method (D6): every share is rounded down, then the paise left over go one each to the shares
 * with the biggest fractional part (ties: earlier index). The shares always sum to `total`
 * exactly, and no share exceeds its weight when total <= sum(weights).
 */
export function allocateProportionally(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('Invalid total');
  if (!weights.every((w) => Number.isSafeInteger(w) && w >= 0)) {
    throw new RangeError('Invalid weights');
  }
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (weights.length === 0) {
    if (total === 0) return [];
    throw new RangeError('Nothing to allocate to');
  }
  if (sum === 0) {
    if (total === 0) return weights.map(() => 0);
    throw new RangeError('Weights sum to zero');
  }

  const T = BigInt(total);
  const S = BigInt(sum);
  const shares = weights.map((w) => (T * BigInt(w)) / S); // floor
  const remainders = weights.map((w) => (T * BigInt(w)) % S);
  let leftover = Number(T - shares.reduce((acc, s) => acc + s, 0n));

  const order = weights
    .map((_, i) => i)
    .sort((i, j) =>
      remainders[j] > remainders[i] ? 1 : remainders[j] < remainders[i] ? -1 : i - j,
    );
  for (const i of order) {
    if (leftover === 0) break;
    shares[i] += 1n;
    leftover -= 1;
  }
  return shares.map(Number);
}
