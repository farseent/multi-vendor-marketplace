import { SEARCH } from '../../config/constants.js';
import { productIndexBody } from './search.mapping.js';
import { buildEsRequest } from './search.query.js';

const statusOf = (err) => err?.meta?.statusCode ?? err?.statusCode;

/**
 * The only file that talks to Elasticsearch. Everything else depends on this small interface,
 * so tests can pass an in-memory fake with the same methods:
 *   ensureIndex()  search(params)  bulk(ops, { index? })
 *   createIndex()  refresh(index)  swapAlias(newIndex)  deleteIndex(index)
 * `ops` are { op:'index', id, version, doc } | { op:'delete', id, version }.
 */
export function createSearchIndex({ client, alias = SEARCH.alias }) {
  async function aliasTargets() {
    try {
      return Object.keys(await client.indices.getAlias({ name: alias }));
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
  }

  async function createIndex(name = `${alias}_v${Date.now()}`) {
    await client.indices.create({ index: name, ...productIndexBody });
    return name;
  }

  return {
    alias,
    createIndex,

    /**
     * Creates the first index + alias when none exists. Safe to call repeatedly, and safe when
     * several instances boot at once: the first index has a FIXED name, so the loser of the race
     * gets "already exists", ignores it, and just (re)attaches the alias. (Random names would
     * leave the alias pointing at two indices, which breaks writes.)
     */
    async ensureIndex() {
      if ((await aliasTargets()).length > 0) return;
      const name = `${alias}_v0`;
      try {
        await createIndex(name);
      } catch (err) {
        if (err?.meta?.body?.error?.type !== 'resource_already_exists_exception') throw err;
      }
      await client.indices.putAlias({ index: name, name: alias });
    },

    async search(params) {
      const res = await client.search({
        index: alias,
        ...buildEsRequest(params),
      });
      const total = typeof res.hits.total === 'number' ? res.hits.total : res.hits.total.value;
      const items = res.hits.hits.map((hit) => ({
        id: hit._id,
        ...hit._source,
      }));
      return { items, total };
    },

    /**
     * Applies index/delete operations. Returns { failed: [{ id, error }] }.
     * Throws only when the request itself fails (ES unreachable), so the caller can tell an
     * outage from a bad document. External versioning rejects stale writes with 409, which is
     * the desired outcome, so a conflict counts as success. Deleting a missing doc (404) too.
     */
    async bulk(ops, { index = alias } = {}) {
      if (ops.length === 0) return { failed: [] };
      const operations = ops.flatMap((o) => {
        const meta = {
          _index: index,
          _id: o.id,
          version: o.version,
          version_type: 'external_gte',
        };
        return o.op === 'index' ? [{ index: meta }, o.doc] : [{ delete: meta }];
      });
      const res = await client.bulk({ operations, refresh: false });
      const failed = [];
      res.items.forEach((item, i) => {
        const result = item.index ?? item.delete;
        const ok = result.status < 300 || result.status === 409 || result.status === 404;
        if (!ok)
          failed.push({
            id: ops[i].id,
            error: result.error?.type ?? `status ${result.status}`,
          });
      });
      return { failed };
    },

    refresh: (index) => client.indices.refresh({ index }),

    /** Atomically points the alias at `newIndex` and returns the indices it used to point at. */
    async swapAlias(newIndex) {
      const old = (await aliasTargets()).filter((name) => name !== newIndex);
      await client.indices.updateAliases({
        actions: [
          ...old.map((index) => ({ remove: { index, alias } })),
          { add: { index: newIndex, alias } },
        ],
      });
      return old;
    },

    async deleteIndex(index) {
      await client.indices.delete({ index, ignore_unavailable: true });
    },
  };
}
