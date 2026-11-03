import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiDownload } from './api.js';
import { canDownloadInvoice, invoiceErrorMessage, invoiceFilename } from './invoices.js';

afterEach(() => vi.unstubAllGlobals());

describe('canDownloadInvoice', () => {
  it.each([
    ['paid', true],
    ['unpaid', false],
    ['failed', false],
  ])('%s -> %s', (paymentStatus, expected) => {
    expect(canDownloadInvoice({ paymentStatus })).toBe(expected);
  });
});

describe('invoiceFilename', () => {
  it('reads the name from Content-Disposition, or falls back', () => {
    expect(invoiceFilename('attachment; filename="INV-2026-000001.pdf"')).toBe(
      'INV-2026-000001.pdf',
    );
    expect(invoiceFilename(null)).toBe('invoice.pdf');
    expect(invoiceFilename('attachment')).toBe('invoice.pdf');
    expect(invoiceFilename('attachment; filename="../../etc/passwd"')).toBe('invoice.pdf');
  });
});

describe('invoiceErrorMessage', () => {
  it('explains the unpaid case and a missing order', () => {
    expect(invoiceErrorMessage({ status: 409, details: { reason: 'order_not_paid' } })).toMatch(
      /once the order is paid/,
    );
    expect(invoiceErrorMessage({ status: 404 })).toBe('Order not found.');
    expect(invoiceErrorMessage({ message: 'Cannot reach the server' })).toBe(
      'Cannot reach the server',
    );
  });
});

describe('apiDownload', () => {
  it('returns the bytes and the Content-Disposition header', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('%PDF-1.3', {
          status: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="INV-2026-000001.pdf"',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { blob, contentDisposition } = await apiDownload('/orders/o1/invoice', {
      baseUrl: '/api/v1',
    });
    expect(await blob.text()).toBe('%PDF-1.3');
    expect(contentDisposition).toContain('INV-2026-000001.pdf');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/o1/invoice');
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
  });

  it('turns the error envelope into an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: {
                code: 'CONFLICT',
                message: 'Not paid',
                details: { reason: 'order_not_paid' },
              },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const error = await apiDownload('/orders/o1/invoice', { baseUrl: '/api/v1' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(error.details.reason).toBe('order_not_paid');
  });

  it('reports an unreachable server as NETWORK_ERROR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('failed');
      }),
    );
    const error = await apiDownload('/x', { baseUrl: '/api/v1' }).catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});
