import mongoose from 'mongoose';

export async function connectMongo({ uri, logger }) {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  logger.info('MongoDB connected');

  // Orders, stock and coupons use multi-document transactions (D1, D7), which need a replica set.
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName) {
    logger.warn('MongoDB is not a replica set: transactions will fail from Phase 5 onwards');
  }
}

export function disconnectMongo() {
  return mongoose.disconnect();
}

export async function pingMongo() {
  if (mongoose.connection.readyState !== 1) throw new Error('MongoDB not connected');
  await mongoose.connection.db.admin().ping();
}
