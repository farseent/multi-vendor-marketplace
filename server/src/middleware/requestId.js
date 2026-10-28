import { randomUUID } from 'node:crypto';

// Accept a caller-supplied ID only if it is a safe token (prevents log injection).
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id =
    incoming && SAFE_ID.test(incoming)
      ? incoming
      : `req_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  res.setHeader('X-Request-Id', req.id);
  next();
}
