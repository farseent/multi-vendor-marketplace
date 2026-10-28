import { z } from 'zod';

/**
 * Validates req.body / req.query / req.params against Zod schemas.
 * Parsed (trimmed, lowercased...) values land on `req.valid`; handlers must read from there.
 * Schemas for bodies should use z.strictObject so unknown keys are rejected (422).
 * Error paths come out as `body.email`, matching API_CONTRACTS.
 */
export function validate({ body, query, params }) {
  const schema = z.object({
    body: body ?? z.any(),
    query: query ?? z.any(),
    params: params ?? z.any(),
  });
  return (req, _res, next) => {
    const result = schema.safeParse({ body: req.body, query: req.query, params: req.params });
    if (!result.success) return next(result.error); // the central handler maps ZodError -> 422
    req.valid = result.data;
    next();
  };
}
