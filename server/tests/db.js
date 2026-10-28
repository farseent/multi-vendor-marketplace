import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { RefreshToken } from '../src/modules/auth/auth.model.js';
import { User } from '../src/modules/users/users.model.js';

/**
 * In-memory single-node replica set (same topology as docker-compose, so Phase 5 transaction
 * tests can reuse this). Call in beforeAll/afterAll. Set MONGOMS_SYSTEM_BINARY to use a local
 * mongod instead of downloading one.
 */
export async function startTestDb() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: 'marketplace_test' });
  await Promise.all([User.init(), RefreshToken.init()]); // build unique indexes before tests
  return replSet;
}

export async function stopTestDb(replSet) {
  await mongoose.disconnect();
  await replSet.stop();
}

export async function clearDb() {
  await Promise.all([User.deleteMany({}), RefreshToken.deleteMany({})]);
}
