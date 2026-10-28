import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AppError } from '../../lib/AppError.js';

export const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');

/** Opaque 256-bit refresh token. `raw` goes in the cookie, `hash` in the database. */
export function generateRefreshToken() {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

/** Short-lived signed JWT. Claims: sub (user id) and role. HS256 only (algorithm pinned). */
export function createAccessTokenService({ secret, ttlSeconds }) {
  return {
    sign(user) {
      return jwt.sign({ role: user.role }, secret, {
        algorithm: 'HS256',
        subject: String(user.id),
        expiresIn: ttlSeconds,
      });
    },
    verify(token) {
      try {
        const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
        if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
          throw new Error('missing claims');
        }
        return { id: payload.sub, role: payload.role };
      } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
          throw new AppError('TOKEN_EXPIRED', 401, 'Access token expired');
        }
        throw new AppError('UNAUTHENTICATED', 401, 'Invalid or missing access token');
      }
    },
  };
}
