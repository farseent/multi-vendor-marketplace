import { z } from 'zod';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Invalid email'));
const name = z.string().trim().min(2, 'Name must be 2-80 characters').max(80);

// 10-72 chars with a letter and a digit. bcrypt only reads the first 72 *bytes*, so multi-byte
// characters are limited by byte length to avoid silent truncation.
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .refine((v) => Buffer.byteLength(v) <= 72, 'Password must be at most 72 characters')
  .refine((v) => /[A-Za-z]/.test(v), 'Password must contain a letter')
  .refine((v) => /\d/.test(v), 'Password must contain a digit');

export const registerBody = z.strictObject({ name, email, password: passwordSchema });

// Login does not re-check password strength: it only needs *a* string (and must be a string,
// which also blocks { "$gt": "" } style operator objects).
export const loginBody = z.strictObject({
  email,
  password: z.string().min(1).max(200),
});

export const changePasswordBody = z
  .strictObject({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'New password must be different from the current one',
  });
