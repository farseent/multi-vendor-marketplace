// npm run reindex   Rebuilds the Elasticsearch index from MongoDB (alias swap, no downtime).
import { parseEnv } from '../config/env.js';
import { createJobLocks } from '../jobs/jobLock.js';
import { connectMongo, disconnectMongo } from '../lib/db.js';
import { createEsClient } from '../lib/es.js';
import { createLogger } from '../lib/logger.js';
import { Product } from '../modules/catalog/products.model.js';
import { createSearchIndex } from '../modules/search/search.index.js';
import { createReindexer } from '../modules/search/search.reindex.js';

let env;
try {
  env = parseEnv(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const logger = createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV });
const es = createEsClient({ url: env.ELASTICSEARCH_URL });
let exitCode = 0;
try {
  await connectMongo({ uri: env.MONGODB_URI, logger });
  await Product.init();
  const searchIndex = createSearchIndex({ client: es });
  const reindexer = createReindexer({
    searchIndex,
    jobLocks: createJobLocks(),
    logger,
  });
  console.log(JSON.stringify(await reindexer.reindexAll()));
} catch (err) {
  console.error(err.message);
  exitCode = 1;
} finally {
  await Promise.allSettled([disconnectMongo(), es.close()]);
}
process.exit(exitCode);
