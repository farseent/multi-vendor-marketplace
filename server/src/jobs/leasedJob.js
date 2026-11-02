import { randomUUID } from 'node:crypto';

/**
 * Wraps a unit of work in the standard job behaviour (D17): a Mongo lease so only one API
 * instance runs it at a time, an interval timer that never overlaps itself, and errors that are
 * logged instead of thrown. Same shape as the search sync job.
 *
 * `run()` does one pass and returns a small result object.
 */
export function createLeasedJob({ name, intervalMs, leaseMs, jobLocks, logger, run }) {
  const owner = randomUUID();
  let timer = null;
  let running = false;

  async function tick() {
    if (!(await jobLocks.acquire(name, owner, leaseMs))) return { skipped: true };
    try {
      return await run();
    } finally {
      await jobLocks.release(name, owner);
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
          await tick();
        } catch (err) {
          logger.error({ err, job: name }, 'Job tick failed');
        } finally {
          running = false;
        }
      }, intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
