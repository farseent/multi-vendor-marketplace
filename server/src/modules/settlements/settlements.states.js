import { SETTLEMENT_TRANSITIONS } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';

/** Settlement state machine (ARCHITECTURE 3.5). The table lives in config/constants.js. */
export const canSettlementTransition = (from, to) =>
  Boolean(SETTLEMENT_TRANSITIONS[from]?.includes(to));

export function assertSettlementTransition(from, to) {
  if (!canSettlementTransition(from, to)) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      409,
      `A settlement cannot go from ${from} to ${to}`,
      { from, to },
    );
  }
}
