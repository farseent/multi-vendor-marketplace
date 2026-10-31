import mongoose from 'mongoose';

// `jobLocks`: { _id: jobName, lockedUntil, owner } (DATABASE_SCHEMA, supporting collections).
const jobLockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    lockedUntil: { type: Date, required: true },
    owner: { type: String, required: true },
  },
  { collection: 'jobLocks', versionKey: false },
);

export const JobLock = mongoose.models.JobLock ?? mongoose.model('JobLock', jobLockSchema);

/**
 * Mongo lease so only one instance runs a job at a time (D17).
 * acquire() succeeds when no lock exists or the previous lease has expired. The upsert collides
 * on the unique _id while someone else holds a live lease, which is how we detect "taken".
 */
export function createJobLocks() {
  return {
    async acquire(name, owner, ttlMs) {
      const now = new Date();
      try {
        await JobLock.findOneAndUpdate(
          { _id: name, lockedUntil: { $lt: now } },
          { $set: { lockedUntil: new Date(now.getTime() + ttlMs), owner } },
          { upsert: true },
        );
        return true;
      } catch (err) {
        if (err?.code === 11000) return false;
        throw err;
      }
    },

    /** Extends our own lease (long jobs such as reindex). False if we lost it. */
    async renew(name, owner, ttlMs) {
      const res = await JobLock.updateOne(
        { _id: name, owner },
        { $set: { lockedUntil: new Date(Date.now() + ttlMs) } },
      );
      return res.matchedCount === 1;
    },

    async release(name, owner) {
      await JobLock.updateOne({ _id: name, owner }, { $set: { lockedUntil: new Date(0) } });
    },
  };
}
