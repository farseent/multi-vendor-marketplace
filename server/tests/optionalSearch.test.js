import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSearchOutbox } from '../src/modules/search/search.outbox.js';
import { SearchOutbox } from '../src/modules/search/search.model.js';

// D70: without Elasticsearch nothing drains the outbox, so it must not be written to at all.
describe('search outbox when Elasticsearch is not configured', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes nothing when disabled', async () => {
    const insertMany = vi.spyOn(SearchOutbox, 'insertMany').mockResolvedValue([]);
    await createSearchOutbox({ enabled: false }).enqueue(['a', 'b']);
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('still writes (de-duplicated) entries when enabled, which is the default', async () => {
    const insertMany = vi.spyOn(SearchOutbox, 'insertMany').mockResolvedValue([]);
    await createSearchOutbox().enqueue(['a', 'a', 'b']);
    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(insertMany.mock.calls[0][0].map((row) => row.productId)).toEqual(['a', 'b']);
  });
});
