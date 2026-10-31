import { randomUUID } from 'node:crypto';
import { SEARCH_SYNC } from '../config/constants.js';
import { opsForProductIds } from '../modules/search/search.docs.js';
import { SearchOutbox } from '../modules/search/search.model.js';

const entryBackoffMs = (attempts) => Math.min(1000 * 2 ** attempts, SEARCH_SYNC.maxBackoffMs);

/**
 * Drains the search outbox into Elasticsearch (ARCHITECTURE 3.6). One tick = claim a batch,
 * bulk apply, delete what succeeded. Lease-guarded so several API instances never double-run.
 *
 * Two kinds of failure are handled differently:
 *  - the request fails (ES unreachable): nothing is wrong with the entries, so we pause the whole
 *    job with a growing back-off and leave entries untouched. An outage therefore never burns
 *    their attempt budget, and the outbox drains by itself once ES is back.
 *  - ES rejects individual documents: that entry's `attempts` goes up with its own back-off, and
 *    after SEARCH_SYNC.maxAttempts it is flagged (kept, logged at error) for an admin.
 */
export function createSearchSyncJob({ searchIndex, jobLocks, logger, config = SEARCH_SYNC }) {
  const owner = randomUUID();
  let indexReady = false;
  let outageCount = 0;
  let pausedUntil = 0;
  let timer = null;
  let running = false;

  async function tick() {
    if (!searchIndex || Date.now() < pausedUntil) return { skipped: true };
    if (!(await jobLocks.acquire(config.jobName, owner, config.leaseMs))) return { skipped: true };
    try {
      const claimed = await SearchOutbox.find({
        nextAttemptAt: { $lte: new Date() },
        attempts: { $lt: config.maxAttempts },
      })
        .sort({ createdAt: 1 })
        .limit(config.batchSize);
      if (claimed.length === 0) return { processed: 0 };

      const productIds = [...new Set(claimed.map((e) => String(e.productId)))];
      let failed;
      try {
        if (!indexReady) {
          await searchIndex.ensureIndex();
          indexReady = true;
        }
        ({ failed } = await searchIndex.bulk(await opsForProductIds(productIds)));
      } catch (err) {
        outageCount += 1;
        const wait = Math.min(
          config.outageBackoffMs.min * 2 ** (outageCount - 1),
          config.outageBackoffMs.max,
        );
        pausedUntil = Date.now() + wait;
        logger.warn(
          { err: err.message, retryInMs: wait },
          'Search sync paused: Elasticsearch unavailable',
        );
        return { paused: true };
      }
      outageCount = 0;

      const failedById = new Map(failed.map((f) => [f.id, f.error]));
      const okEntries = claimed.filter((e) => !failedById.has(String(e.productId)));
      const badEntries = claimed.filter((e) => failedById.has(String(e.productId)));

      // Delete by _id: an entry added while we were working stays for the next tick.
      await SearchOutbox.deleteMany({
        _id: { $in: okEntries.map((e) => e._id) },
      });
      for (const entry of badEntries) {
        const attempts = entry.attempts + 1;
        await SearchOutbox.updateOne(
          { _id: entry._id },
          {
            $set: {
              attempts,
              lastError: failedById.get(String(entry.productId)),
              nextAttemptAt: new Date(Date.now() + entryBackoffMs(attempts)),
            },
          },
        );
        if (attempts >= config.maxAttempts) {
          logger.error(
            {
              productId: String(entry.productId),
              lastError: failedById.get(String(entry.productId)),
            },
            'Search outbox entry exhausted its attempts and needs admin attention',
          );
        }
      }
      return { processed: okEntries.length, failed: badEntries.length };
    } finally {
      await jobLocks.release(config.jobName, owner);
    }
  }

  return {
    tick,

    /** Runs tick() on an interval, never overlapping itself and never throwing. */
    start() {
      if (timer || !searchIndex) return;
      timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
          await tick();
        } catch (err) {
          logger.error({ err }, 'Search sync tick failed');
        } finally {
          running = false;
        }
      }, config.intervalMs);
      timer.unref();
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}