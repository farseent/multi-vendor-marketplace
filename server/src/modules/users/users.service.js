import { MAX_ADDRESSES } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { hashPassword } from '../../lib/password.js';
import { User } from './users.model.js';

const notFound = (what) => new AppError('NOT_FOUND', 404, `${what} not found`);

async function loadUser(userId) {
  const user = await User.findById(userId);
  if (!user) throw notFound('User');
  return user;
}

/** Invariant: a non-empty address book always has exactly one default. */
function normalizeDefault(user, preferred) {
  if (preferred) for (const a of user.addresses) a.isDefault = a.id === preferred.id;
  else if (user.addresses.length > 0 && !user.addresses.some((a) => a.isDefault)) {
    user.addresses[0].isDefault = true;
  }
}

export function createUsersService() {
  return {
    getMe: loadUser,

    async updateMe(userId, { name, phone }) {
      const user = await loadUser(userId);
      if (name !== undefined) user.name = name;
      if (phone !== undefined) user.phone = phone ?? undefined;
      return user.save();
    },

    async listAddresses(userId) {
      return (await loadUser(userId)).addresses;
    },

    async addAddress(userId, data) {
      const user = await loadUser(userId);
      if (user.addresses.length >= MAX_ADDRESSES) {
        throw new AppError('CONFLICT', 409, `You can save at most ${MAX_ADDRESSES} addresses`);
      }
      const isDefault = data.isDefault === true || user.addresses.length === 0;
      user.addresses.push({ ...data, isDefault: false });
      const created = user.addresses.at(-1);
      normalizeDefault(user, isDefault ? created : null);
      await user.save();
      return created;
    },

    async updateAddress(userId, addressId, patch) {
      const user = await loadUser(userId);
      const address = user.addresses.id(addressId);
      if (!address) throw notFound('Address'); // also covers "belongs to someone else"
      const { isDefault, ...fields } = patch;
      address.set(fields);
      // Un-defaulting is done by choosing another default; normalize keeps the invariant.
      normalizeDefault(user, isDefault === true ? address : null);
      await user.save();
      return address;
    },

    async deleteAddress(userId, addressId) {
      const user = await loadUser(userId);
      const address = user.addresses.id(addressId);
      if (!address) throw notFound('Address');
      address.deleteOne();
      normalizeDefault(user, null);
      await user.save();
    },

    /**
     * Admin accounts exist only via the seed script (PROJECT_MASTER section 3).
     * Idempotent for an existing admin; refuses to promote a non-admin account.
     */
    async createAdminUser({ name, email, password }, { bcryptCost }) {
      const existing = await User.findOne({ email });
      if (existing) {
        if (existing.role !== 'admin') {
          throw new AppError('CONFLICT', 409, 'A non-admin account already uses this email');
        }
        return { created: false, user: existing };
      }
      const passwordHash = await hashPassword(password, bcryptCost);
      const user = await User.create({ name, email, passwordHash, role: 'admin' });
      return { created: true, user };
    },
  };
}
