import { RECONCILIATION_JOB } from '../config/constants.js';
import { ReconciliationReport } from '../modules/settlements/reconciliation.model.js';
import { createLeasedJob } from './leasedJob.js';

/**
 * The daily reconciliation (ARCHITECTURE 3.5). It wakes every hour and runs only when the newest
 * report is older than `minGapMs`, so a restart neither skips a day nor repeats one.
 */
export function createReconciliationJob({
  reconciliationService,
  jobLocks,
  logger,
  config = RECONCILIATION_JOB,
  clock = () => new Date(),
}) {
  return createLeasedJob({
    name: config.jobName,
    intervalMs: config.intervalMs,
    leaseMs: config.leaseMs,
    jobLocks,
    logger,
    async run() {
      const now = clock();
      const last = await ReconciliationReport.findOne().sort({ runAt: -1 });
      if (last && now.getTime() - last.runAt.getTime() < config.minGapMs) return { skipped: true };
      const report = await reconciliationService.run({ trigger: 'job', now });
      return { reportId: report.id, status: report.status };
    },
  });
}
