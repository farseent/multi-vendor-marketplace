import { randomUUID } from 'node:crypto';
import { AppError } from '../../lib/AppError.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { User } from '../users/users.model.js';
import { RefreshToken } from './auth.model.js';
import { generateRefreshToken, hashToken } from './auth.tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const unauthenticated = (message = 'Invalid or expired session') =>
  new AppError('UNAUTHENTICATED', 401, message);
const suspended = () => new AppError('ACCOUNT_SUSPENDED', 403, 'This account is suspended');

/** Business rules for sessions. Knows nothing about req/res/cookies (controller's job). */
export function createAuthService({ accessTokens, config }) {
  // Compared against when the email is unknown, so "no such user" costs the same time as
  // "wrong password" and login timing does not reveal which emails exist.
  const dummyHash = hashPassword('not-a-real-password-1', config.bcryptCost);

  const revokeFamily = (familyId) =>
    RefreshToken.updateMany({ familyId, revokedAt: null }, { revokedAt: new Date() });

  async function startSession(user, meta) {
    const refresh = generateRefreshToken();
    const expiresAt = new Date(Date.now() + config.refreshTtlDays * DAY_MS);
    await RefreshToken.create({
      userId: user._id,
      tokenHash: refresh.hash,
      familyId: randomUUID(),
      expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return {
      user,
      accessToken: accessTokens.sign(user),
      refreshToken: refresh.raw,
      refreshExpiresAt: expiresAt,
    };
  }

  async function register({ name, email, password }, role, meta) {
    const passwordHash = await hashPassword(password, config.bcryptCost);
    // The unique email index is the source of truth: a duplicate surfaces as Mongo 11000,
    // which the error handler maps to 409 CONFLICT (no check-then-insert race).
    const user = await User.create({ name, email, passwordHash, role });
    return startSession(user, meta);
  }

  async function login({ email, password }, meta) {
    const user = await User.findOne({ email }).select('+passwordHash');
    const valid = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
    if (!user || !valid) throw unauthenticated('Invalid email or password');
    if (user.status !== 'active') throw suspended();

    await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
    return startSession(user, meta);
  }

  /**
   * Rotation with reuse detection: every refresh token works exactly once.
   * Presenting an already-used token means it was copied, so the whole family is revoked.
   */
  async function refresh(rawToken, meta) {
    if (!rawToken) throw unauthenticated();
    const existing = await RefreshToken.findOne({ tokenHash: hashToken(rawToken) });
    if (!existing) throw unauthenticated();

    if (existing.revokedAt) {
      await revokeFamily(existing.familyId); // reuse detected
      throw unauthenticated();
    }
    if (existing.expiresAt <= new Date()) throw unauthenticated();

    const user = await User.findById(existing.userId);
    if (!user) {
      await revokeFamily(existing.familyId);
      throw unauthenticated();
    }
    if (user.status !== 'active') {
      await revokeFamily(existing.familyId);
      throw suspended();
    }

    const next = generateRefreshToken();
    // Atomic claim: if two requests race with the same token, only one matches revokedAt:null.
    const claimed = await RefreshToken.findOneAndUpdate(
      { _id: existing._id, revokedAt: null },
      { revokedAt: new Date(), replacedByHash: next.hash },
    );
    if (!claimed) {
      await revokeFamily(existing.familyId);
      throw unauthenticated();
    }

    const expiresAt = new Date(Date.now() + config.refreshTtlDays * DAY_MS);
    await RefreshToken.create({
      userId: user._id,
      tokenHash: next.hash,
      familyId: existing.familyId,
      expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return {
      user,
      accessToken: accessTokens.sign(user),
      refreshToken: next.raw,
      refreshExpiresAt: expiresAt,
    };
  }

  /** Idempotent: unknown or missing tokens are ignored. */
  async function logout(rawToken) {
    if (!rawToken) return;
    const existing = await RefreshToken.findOne({ tokenHash: hashToken(rawToken) });
    if (existing) await revokeFamily(existing.familyId);
  }

  async function getUser(userId) {
    const user = await User.findById(userId);
    if (!user) throw unauthenticated();
    return user;
  }

  /** Revokes every session except the one making the request (identified by its cookie). */
  async function changePassword(userId, { currentPassword, newPassword }, currentRawToken) {
    const user = await User.findById(userId).select('+passwordHash');
    if (!user) throw unauthenticated();
    if (user.status !== 'active') throw suspended();

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new AppError('VALIDATION_ERROR', 422, 'Invalid request', [
        { path: 'body.currentPassword', message: 'Incorrect password' },
      ]);
    }
    user.passwordHash = await hashPassword(newPassword, config.bcryptCost);
    await user.save();

    let keepFamily = null;
    if (currentRawToken) {
      const current = await RefreshToken.findOne({
        tokenHash: hashToken(currentRawToken),
        userId,
        revokedAt: null,
      });
      keepFamily = current?.familyId ?? null;
    }
    await RefreshToken.updateMany(
      { userId, revokedAt: null, ...(keepFamily && { familyId: { $ne: keepFamily } }) },
      { revokedAt: new Date() },
    );
  }

  return { register, login, refresh, logout, getUser, changePassword };
}
