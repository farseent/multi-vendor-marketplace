import { SUB_ORDER_TRANSITIONS } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';

/**
 * The sub-order state machine (API_CONTRACTS section 3). One table, one function, so the vendor
 * route, the customer cancel and the admin refund cannot disagree about what is allowed.
 * actor: 'vendor' | 'customer' | 'system'.
 */
export function canTransition(from, to, actor) {
  return Boolean(SUB_ORDER_TRANSITIONS[from]?.[to]?.includes(actor));
}

/** Throws 409 INVALID_STATE_TRANSITION unless `actor` may move a sub-order from -> to. */
export function assertTransition(from, to, actor) {
  if (!canTransition(from, to, actor)) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      409,
      `A sub-order cannot go from ${from} to ${to}`,
      { from, to },
    );
  }
}
