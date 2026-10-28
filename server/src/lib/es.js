import { Client } from '@elastic/elasticsearch';

export function createEsClient({ url }) {
  return new Client({ node: url, requestTimeout: 3000, maxRetries: 1 });
}

export async function pingEs(client) {
  const ok = await client.ping();
  if (!ok) throw new Error('Elasticsearch ping failed');
}
