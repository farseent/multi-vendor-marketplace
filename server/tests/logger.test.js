import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';

describe('logger redaction', () => {
  it('redacts credentials and tokens, keeps other fields', () => {
    const lines = [];
    const logger = createLogger(
      { level: 'info', nodeEnv: 'test' },
      { write: (l) => lines.push(l) },
    );
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc', cookie: 'rt=xyz', 'x-request-id': 'r1' } },
        body: { email: 'a@b.com', password: 'hunter2' },
        accessToken: 'jwt-value',
      },
      'sample',
    );
    const out = lines.join('');
    expect(out).not.toMatch(/Bearer abc|rt=xyz|hunter2|jwt-value/);
    expect(out).toContain('a@b.com');
    expect(out).toContain('[Redacted]');
  });
});