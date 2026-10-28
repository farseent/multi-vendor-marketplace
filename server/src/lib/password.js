import bcrypt from 'bcrypt';

export const hashPassword = (plain, cost) => bcrypt.hash(plain, cost);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);
