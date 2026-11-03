import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPaymentProvider } from '../src/providers/payment/index.js';
import { createRazorpayProvider } from '../src/providers/payment/razorpay.js';

const KEY_ID = 'rzp_test_abc123';
const KEY_SECRET = 'super-secret-key';
const WEBHOOK_SECRET = 'whsec-123';

/** A fetch stub: answers from `replies` in order and records every request. */
function fakeFetch(...replies) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body } = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new Error('no json');
        return body;
      },
    };
  };
  return { impl, requests };
}
const make = (...replies) => {
  const f = fakeFetch(...replies);
  return {
    ...f,
    provider: createRazorpayProvider({
      keyId: KEY_ID,
      keySecret: KEY_SECRET,
      webhookSecret: WEBHOOK_SECRET,
      fetchImpl: f.impl,
    }),
  };
};

describe('createOrder (S1)', () => {
  const input = {
    amountPaise: 270000,
    receipt: 'MP-20261101-000007',
    transfers: [
      {
        linkedAccountId: 'acc_AAA',
        amountPaise: 100000,
        notes: { orderNumber: 'MP-1', subOrderNumber: 'MP-1-V1' },
      },
      {
        linkedAccountId: 'acc_BBB',
        amountPaise: 150000,
        notes: { orderNumber: 'MP-1', subOrderNumber: 'MP-1-V2' },
      },
    ],
  };

  it('POSTs the order with one on-hold transfer per sub-order and maps the transfer ids by recipient', async () => {
    const { provider, requests } = make({
      body: {
        id: 'order_X1',
        transfers: [
          { id: 'trf_B', recipient: 'acc_BBB' },
          { id: 'trf_A', recipient: 'acc_AAA' },
        ],
      },
    });
    const res = await provider.createOrder(input);
    expect(res).toEqual({
      providerOrderId: 'order_X1',
      transfers: [
        { linkedAccountId: 'acc_AAA', providerTransferId: 'trf_A' },
        { linkedAccountId: 'acc_BBB', providerTransferId: 'trf_B' },
      ],
    });
    const [req] = requests;
    expect(req.url).toBe('https://api.razorpay.com/v1/orders');
    expect(req.method).toBe('POST');
    expect(req.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`,
    );
    expect(req.body).toEqual({
      amount: 270000,
      currency: 'INR',
      receipt: 'MP-20261101-000007',
      transfers: [
        {
          account: 'acc_AAA',
          amount: 100000,
          currency: 'INR',
          notes: input.transfers[0].notes,
          on_hold: true,
        },
        {
          account: 'acc_BBB',
          amount: 150000,
          currency: 'INR',
          notes: input.transfers[1].notes,
          on_hold: true,
        },
      ],
    });
    expect(req.body.transfers.every((t) => !('on_hold_until' in t))).toBe(true); // held until released (D45)
  });

  it('falls back to request order when Razorpay omits the recipient', async () => {
    const { provider } = make({
      body: { id: 'order_X2', transfers: [{ id: 'trf_1' }, { id: 'trf_2' }] },
    });
    const res = await provider.createOrder(input);
    expect(res.transfers.map((t) => t.providerTransferId)).toEqual(['trf_1', 'trf_2']);
  });

  it('fails if a requested transfer is missing from the answer, or there is no order id', async () => {
    await expect(
      make({
        body: { id: 'order_X3', transfers: [{ id: 'trf_A', recipient: 'acc_AAA' }] },
      }).provider.createOrder(input),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
    await expect(
      make({ body: { transfers: [] } }).provider.createOrder({ ...input, transfers: [] }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
  });
});

describe('error handling', () => {
  it('turns an HTTP error into a 502 with only the status and code, never Razorpay’s text or our secrets', async () => {
    const { provider } = make({
      status: 400,
      body: {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'The sum of amount requested for transfer is greater than ...',
        },
      },
    });
    const err = await provider
      .createOrder({ amountPaise: 100, receipt: 'r', transfers: [] })
      .catch((e) => e);
    expect(err).toMatchObject({
      code: 'PAYMENT_PROVIDER_ERROR',
      status: 502,
      details: { providerStatus: 400, providerCode: 'BAD_REQUEST_ERROR' },
    });
    expect(JSON.stringify(err.details) + err.message).not.toMatch(
      /sum of amount|super-secret|rzp_test/,
    );
  });

  it('maps network failures and non-JSON answers to 502', async () => {
    await expect(
      make(new Error('ECONNRESET super-secret-key')).provider.fetchPayment('pay_1'),
    ).rejects.toMatchObject({ status: 502, message: 'The payment provider could not be reached' });
    await expect(
      make({ status: 200, body: undefined }).provider.fetchPayment('pay_1'),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      make({ status: 503, body: undefined }).provider.fetchPayment('pay_1'),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('passes an abort signal so a hung request times out', async () => {
    const { provider, requests } = make({ body: { id: 'pay_1' } });
    await provider.fetchPayment('pay_1');
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('reads (S17, S18)', () => {
  const entity = {
    id: 'pay_1',
    entity: 'payment',
    amount: 1234,
    currency: 'INR',
    status: 'captured',
    order_id: 'order_1',
    method: 'card',
    captured: true,
  };

  it('fetchPayment maps the payment entity', async () => {
    const { provider, requests } = make({ body: entity });
    expect(await provider.fetchPayment('pay_1')).toEqual({
      id: 'pay_1',
      orderId: 'order_1',
      amountPaise: 1234,
      currency: 'INR',
      status: 'captured',
      method: 'card',
    });
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.razorpay.com/v1/payments/pay_1',
    });
  });

  it('fetchOrderPayments maps the collection', async () => {
    const { provider, requests } = make({
      body: {
        entity: 'collection',
        count: 2,
        items: [{ ...entity, id: 'pay_a', status: 'failed' }, entity],
      },
    });
    const res = await provider.fetchOrderPayments('order_1');
    expect(res.map((p) => [p.id, p.status])).toEqual([
      ['pay_a', 'failed'],
      ['pay_1', 'captured'],
    ]);
    expect(requests[0].url).toBe('https://api.razorpay.com/v1/orders/order_1/payments');
  });

  it('escapes ids in the URL path', async () => {
    const { provider, requests } = make({ body: entity });
    await provider.fetchPayment('../x?y=1');
    expect(requests[0].url).toBe('https://api.razorpay.com/v1/payments/..%2Fx%3Fy%3D1');
  });
});

describe('refundPayment (S4)', () => {
  it('sends amount and reverse_all: 1 for a full refund, and nothing else', async () => {
    const { provider, requests } = make({
      body: { id: 'rfnd_1', entity: 'refund', status: 'processed' },
    });
    expect(
      await provider.refundPayment({
        providerPaymentId: 'pay_9',
        amountPaise: 5000,
        reverseAll: true,
        receipt: 'ignored',
      }),
    ).toEqual({ providerRefundId: 'rfnd_1', status: 'processed' });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.razorpay.com/v1/payments/pay_9/refund',
      body: { amount: 5000, reverse_all: 1 },
    });
    expect(Object.keys(requests[0].body)).toEqual(['amount', 'reverse_all']);
  });

  it('reports a refund that is not yet processed as initiated', async () => {
    const { provider } = make({ body: { id: 'rfnd_2', status: 'pending' } });
    expect(
      (await provider.refundPayment({ providerPaymentId: 'pay_9', amountPaise: 100 })).status,
    ).toBe('initiated');
  });
});

describe('signatures (D46, D48)', () => {
  const { provider } = make();
  const hex = (key, msg) => createHmac('sha256', key).update(msg).digest('hex');

  it('verifies the checkout callback as hmac_sha256(order|payment) with the key secret', () => {
    const good = hex(KEY_SECRET, 'order_1|pay_1');
    expect(
      provider.verifyCheckoutSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        signature: good,
      }),
    ).toBe(true);
    expect(
      provider.verifyCheckoutSignature({
        providerOrderId: 'order_2',
        providerPaymentId: 'pay_1',
        signature: good,
      }),
    ).toBe(false);
    expect(
      provider.verifyCheckoutSignature({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        signature: hex(WEBHOOK_SECRET, 'order_1|pay_1'),
      }),
    ).toBe(false);
  });

  it('verifies webhooks over the raw bytes with the WEBHOOK secret, not the key secret', () => {
    const raw = Buffer.from('{"event":"payment.captured","payload":{}}');
    expect(provider.verifyWebhookSignature(raw, hex(WEBHOOK_SECRET, raw))).toBe(true);
    expect(provider.verifyWebhookSignature(raw, hex(KEY_SECRET, raw))).toBe(false);
    expect(
      provider.verifyWebhookSignature(
        Buffer.from('{"event":"payment.captured", "payload":{}}'),
        hex(WEBHOOK_SECRET, raw),
      ),
    ).toBe(false);
    expect(provider.verifyWebhookSignature(raw, undefined)).toBe(false);
  });
});

describe('payout accounts (D49, S19)', () => {
  it('resolvePayoutAccount needs an attached AND active account', async () => {
    const { provider } = make();
    expect(
      await provider.resolvePayoutAccount({
        payoutAccount: { linkedAccountId: 'acc_1', status: 'active' },
      }),
    ).toEqual({ linkedAccountId: 'acc_1', active: true });
    expect(
      (
        await provider.resolvePayoutAccount({
          payoutAccount: { linkedAccountId: 'acc_1', status: 'pending' },
        })
      ).active,
    ).toBe(false);
    expect(
      (await provider.resolvePayoutAccount({ payoutAccount: { status: 'active' } })).active,
    ).toBe(false);
    expect((await provider.resolvePayoutAccount({})).active).toBe(false);
  });

  it('validateLinkedAccount accepts an existing, unsuspended Route account', async () => {
    const { provider, requests } = make({
      body: { id: 'acc_1', type: 'route', status: 'created' },
    });
    expect(await provider.validateLinkedAccount({ linkedAccountId: 'acc_1' })).toEqual({
      ok: true,
    });
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.razorpay.com/v2/accounts/acc_1',
    });
  });

  it.each([
    [
      'an account that is not ours or does not exist (HTTP 400)',
      { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR' } } },
      'not_found_or_not_yours',
    ],
    [
      'a suspended account',
      { body: { id: 'acc_1', type: 'route', status: 'suspended' } },
      'suspended',
    ],
    [
      'an account that is not a Route account',
      { body: { id: 'acc_1', type: 'standard', status: 'created' } },
      'not_a_route_account',
    ],
  ])('validateLinkedAccount rejects %s', async (_name, reply, reason) => {
    expect(await make(reply).provider.validateLinkedAccount({ linkedAccountId: 'acc_1' })).toEqual({
      ok: false,
      reason,
    });
  });

  it('validateLinkedAccount throws (does not guess) when Razorpay is down', async () => {
    await expect(
      make({ status: 503, body: undefined }).provider.validateLinkedAccount({
        linkedAccountId: 'acc_1',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
  });
});

describe('createPaymentProvider', () => {
  it('builds the mock by default and the Razorpay adapter when configured', () => {
    expect(createPaymentProvider({ PAYMENT_PROVIDER: 'mock' }).name).toBe('mock');
    const real = createPaymentProvider({
      PAYMENT_PROVIDER: 'razorpay',
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    expect(real).toMatchObject({ name: 'razorpay', publicKeyId: KEY_ID });
    expect(JSON.stringify(Object.keys(real))).not.toMatch(/secret/i);
  });
});

describe('Phase 6 transfer and refund calls (S2, S20, S21)', () => {
  it('releaseTransfer PATCHes the transfer with on_hold: false', async () => {
    const { provider, requests } = make({ body: { id: 'trf_1', on_hold: false } });
    expect(await provider.releaseTransfer('trf_1')).toEqual({ providerTransferId: 'trf_1' });
    expect(requests[0].url).toBe('https://api.razorpay.com/v1/transfers/trf_1');
    expect(requests[0].method).toBe('PATCH');
    expect(requests[0].body).toEqual({ on_hold: false });
  });

  it('reverseTransfer POSTs the amount (paise) and notes to /reversals and returns the reversal id', async () => {
    const { provider, requests } = make({
      body: { id: 'rvrsl_9', entity: 'reversal', transfer_id: 'trf_1', amount: 90000 },
    });
    const out = await provider.reverseTransfer({
      providerTransferId: 'trf_1',
      amountPaise: 90000,
      notes: { refundId: 'r1' },
    });
    expect(out).toEqual({ providerReversalId: 'rvrsl_9' });
    expect(requests[0].url).toBe('https://api.razorpay.com/v1/transfers/trf_1/reversals');
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({ amount: 90000, notes: { refundId: 'r1' } });
  });

  it('reverseTransfer treats an answer without an id as a provider error', async () => {
    const { provider } = make({ body: {} });
    await expect(
      provider.reverseTransfer({ providerTransferId: 'trf_1', amountPaise: 100 }),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });
  });

  it('a 400 (e.g. the linked account has too little balance) becomes PAYMENT_PROVIDER_ERROR, never a leak of the body', async () => {
    const { provider } = make({
      status: 400,
      body: { error: { description: 'Insufficient balance in linked account' } },
    });
    const err = await provider
      .reverseTransfer({ providerTransferId: 'trf_1', amountPaise: 100 })
      .catch((e) => e);
    expect(err.code).toBe('PAYMENT_PROVIDER_ERROR');
    expect(err.status).toBe(502);
    expect(JSON.stringify(err)).not.toMatch(/Insufficient/);
  });

  it('fetchTransfer maps amount, amount_reversed, status, on_hold and settlement_status', async () => {
    const { provider, requests } = make({
      body: {
        id: 'trf_1',
        amount: 100000,
        amount_reversed: 25000,
        status: 'partially_reversed',
        on_hold: 1,
        settlement_status: 'on_hold',
      },
    });
    expect(await provider.fetchTransfer('trf_1')).toEqual({
      id: 'trf_1',
      amountPaise: 100000,
      amountReversedPaise: 25000,
      status: 'partially_reversed',
      onHold: true,
      settlementStatus: 'on_hold',
    });
    expect(requests[0].url).toBe('https://api.razorpay.com/v1/transfers/trf_1');
    expect(requests[0].method).toBe('GET');
  });

  it('fetchTransfer treats a missing amount_reversed as 0', async () => {
    const { provider } = make({
      body: {
        id: 'trf_1',
        amount: 500,
        status: 'created',
        on_hold: false,
        settlement_status: 'pending',
      },
    });
    expect((await provider.fetchTransfer('trf_1')).amountReversedPaise).toBe(0);
  });

  it('fetchRefund reads the refund of a payment and normalises the status', async () => {
    for (const [raw, expected] of [
      ['processed', 'processed'],
      ['pending', 'pending'],
      ['failed', 'failed'],
      ['something_new', 'pending'],
    ]) {
      const { provider, requests } = make({
        body: { id: 'rfnd_1', payment_id: 'pay_1', amount: 5000, status: raw },
      });
      const out = await provider.fetchRefund({
        providerPaymentId: 'pay_1',
        providerRefundId: 'rfnd_1',
      });
      expect(out).toMatchObject({
        id: 'rfnd_1',
        paymentId: 'pay_1',
        amountPaise: 5000,
        status: expected,
      });
      expect(requests[0].url).toBe('https://api.razorpay.com/v1/payments/pay_1/refunds/rfnd_1');
    }
  });

  it('path segments are URL-encoded so an id cannot change the path', async () => {
    const { provider, requests } = make({ body: { id: 'x', amount: 1, status: 'created' } });
    await provider.fetchTransfer('trf_1/../../payments');
    expect(requests[0].url).toBe(
      'https://api.razorpay.com/v1/transfers/trf_1%2F..%2F..%2Fpayments',
    );
  });
});
