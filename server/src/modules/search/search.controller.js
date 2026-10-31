const ok = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta && { meta }) });

export function createSearchController({ searchService }) {
  return {
    async search(req, res) {
      const { items, meta, fallback } = await searchService.search(req.valid.query);
      // Tells clients (and our tests) the answer came from the reduced Mongo search.
      if (fallback) res.setHeader('X-Search-Fallback', 'mongo');
      ok(res, items, 200, meta);
    },
  };
}

export function createSearchAdminController({ reindexer, audit }) {
  return {
    async reindex(req, res) {
      const result = await reindexer.reindexAll();
      await audit.record(req.user, {
        action: 'search.reindexed',
        entityType: 'search',
        entityId: req.user.id, // no entity of its own; the audit schema needs an ObjectId
        meta: { indexed: result.indexed, index: result.index },
      });
      ok(res, result);
    },
  };
}