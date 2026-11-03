import { z } from 'zod';
import { SETTLEMENT_STATUSES } from '../../config/constants.js';
import { objectId, paginationQuery } from '../../lib/pagination.js';

export const vendorSettlementsQuery = z.object({
  ...paginationQuery,
  status: z.enum(SETTLEMENT_STATUSES).optional(),
});
export const adminSettlementsQuery = z.object({
  ...paginationQuery,
  status: z.enum(SETTLEMENT_STATUSES).optional(),
  vendorId: objectId('vendor id').optional(),
});
export const settlementParams = z.object({ settlementId: objectId('settlement id') });
export const reportsQuery = z.object({ ...paginationQuery });
