import { ZodError } from 'zod';
import { AppError } from '../lib/AppError.js';

export function notFound(_req, _res, next) {
  next(new AppError('NOT_FOUND', 404, 'Route not found'));
}

/** Map any thrown value to { status, code, message, details }. Unknown errors become 500. */
function normalize(err) {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return { status: 422, code: 'VALIDATION_ERROR', message: 'Invalid request', details };
  }
  // body-parser errors (malformed JSON, body over the size limit)
  if (err?.type === 'entity.parse.failed') {
    return { status: 400, code: 'BAD_REQUEST', message: 'Malformed JSON body' };
  }
  if (err?.type === 'entity.too.large') {
    return { status: 400, code: 'BAD_REQUEST', message: 'Request body too large' };
  }
  // Mongoose, matched by name so this file does not depend on the model layer
  if (err?.name === 'ValidationError' && err.errors) {
    const details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return { status: 422, code: 'VALIDATION_ERROR', message: 'Invalid request', details };
  }
  if (err?.name === 'CastError') {
    return { status: 400, code: 'BAD_REQUEST', message: 'Invalid identifier' };
  }
  if (err?.code === 11000) {
    const details = Object.keys(err.keyPattern ?? {}).map((path) => ({
      path,
      message: 'Already exists',
    }));
    return { status: 409, code: 'CONFLICT', message: 'Duplicate value', details };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

export function createErrorHandler({ nodeEnv, logger }) {
  // Express identifies error handlers by their 4-argument signature.
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    const { status, code, message, details } = normalize(err);
    if (status >= 500) (req.log ?? logger).error({ err, requestId: req.id }, 'Unhandled error');

    const error = { code, message, requestId: req.id };
    if (details !== undefined) error.details = details;
    // Stack traces are a development aid only.
    if (status === 500 && nodeEnv === 'development') error.stack = err?.stack;

    res.status(status).json({ success: false, error });
  };
}
