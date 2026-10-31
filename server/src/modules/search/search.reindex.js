import { randomUUID } from 'node:crypto';
import { SEARCH, SEARCH_SYNC } from '../../config/constants.js';
import { AppError } from '../../lib/AppError.js';
import { Product } from '../catalog/products.model.js';
import { opsForProducts } from './search.docs.js';
import { SearchOutbox } from './search.model.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LEASE_MS = 60_000;

/**
 * Rebuilds the whole index from Mongo behind the alias (ARCHITECTURE 3.6):
 *   new index -> bulk load every public product -> atomically move the alias -> drop old index.
 * Searches keep hitting the old index until the alias moves, so none of them fail.
 *
 * It holds the same lease as the sync job. While it runs the job pauses, so outbox entries pile
 * up instead of being written to the soon-to-be-replaced index; they are applied to the NEW
 * index right after the swap (replays are harmless, versions are external).
 */
export function createReindexer({ searchIndex, jobLocks, logger }) {
  return {
    async reindexAll() {
      if (!searchIndex) {
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'Search is not configured');
      }
      const owner = randomUUID();
      const lockName = SEARCH_SYNC.jobName;

      // The sync job holds the lease only for a moment per tick, so waiting a few seconds is enough.
      let locked = false;
      for (let i = 0; i < 20 && !locked; i++) {
        locked = await jobLocks.acquire(lockName, owner, LEASE_MS);
        if (!locked) await sleep(500);
      }
      if (!locked) {
        throw new AppError('CONFLICT', 409, 'A search sync or reindex is already running');
      }

      const startedAt = new Date();
      let newIndex = null;
      try {
        newIndex = await searchIndex.createIndex();
        let indexed = 0;
        const cursor = Product.find({ status: 'active' }).sort({ _id: 1 }).cursor({
          batchSize: SEARCH.reindexBatchSize,
        });

        let batch = [];
        const flush = async () => {
          if (batch.length === 0) return;
          const ops = (await opsForProducts(batch)).filter((o) => o.op === 'index');
          const { failed } = await searchIndex.bulk(ops, { index: newIndex });
          if (failed.length > 0) {
            throw new Error(
              `Bulk indexing failed for ${failed.length} products: ${failed[0].error}`,
            );
          }
          indexed += ops.length;
          batch = [];
          if (!(await jobLocks.renew(lockName, owner, LEASE_MS))) {
            throw new Error('Lost the reindex lease');
          }
        };
        for await (const product of cursor) {
          batch.push(product);
          if (batch.length >= SEARCH.reindexBatchSize) await flush();
        }
        await flush();

        await searchIndex.refresh(newIndex);
        const old = await searchIndex.swapAlias(newIndex);
        for (const index of old) await searchIndex.deleteIndex(index);

        // The full rebuild covers anything flagged before it started (it read current state).
        await SearchOutbox.deleteMany({
          createdAt: { $lt: startedAt },
          attempts: { $gte: SEARCH_SYNC.maxAttempts },
        });
        logger.info({ index: newIndex, indexed }, 'Search reindex finished');
        return {
          index: newIndex,
          indexed,
          durationMs: Date.now() - startedAt.getTime(),
        };
      } catch (err) {
        // Clean up the half-built index; the alias still points at the old, working one.
        if (newIndex) await searchIndex.deleteIndex(newIndex).catch(() => {});
        if (err instanceof AppError) throw err;
        logger.error({ err }, 'Search reindex failed');
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          503,
          'Reindex failed, the current index is unchanged',
        );
      } finally {
        await jobLocks.release(lockName, owner);
      }
    },
  };
}