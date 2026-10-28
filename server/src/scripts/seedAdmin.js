import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { disconnectMongo, connectMongo } from '../lib/db.js';
import { createUsersService } from '../modules/users/users.service.js';
import { passwordSchema } from '../modules/auth/auth.validator.js';

const seedSchema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/, 'must be a mongodb:// URI'),
  ADMIN_SEED_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  ADMIN_SEED_PASSWORD: passwordSchema,
  ADMIN_SEED_NAME: z.string().trim().min(2).max(80).default('Platform Admin'),
  BCRYPT_COST: z.coerce.number().int().min(12).max(15).default(12),
});

/** Validates the seed env and creates the admin. Assumes Mongoose is already connected. */
export async function seedAdmin(source) {
  const parsed = seedSchema.safeParse(source);
  if (!parsed.success) {
    // Names the bad variables but never prints their values (the password is among them).
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new Error(`Invalid seed configuration: ${keys.join(', ')}`);
  }
  const env = parsed.data;
  return createUsersService().createAdminUser(
    { name: env.ADMIN_SEED_NAME, email: env.ADMIN_SEED_EMAIL, password: env.ADMIN_SEED_PASSWORD },
    { bcryptCost: env.BCRYPT_COST },
  );
}

// CLI entry: `npm run seed:admin -w server`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const logger = { info: console.log, warn: console.warn };
    await connectMongo({ uri: process.env.MONGODB_URI ?? '', logger });
    const { created, user } = await seedAdmin(process.env);
    console.log(created ? `Created admin ${user.email}` : `Admin ${user.email} already exists`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await disconnectMongo();
  }
}
