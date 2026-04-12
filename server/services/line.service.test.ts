import crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exchangeCodeForToken,
  verifyLiffAccessToken,
  verifyWebhookSignature
} from './line.service';

const ORIGINAL_SECRET = process.env.LINE_MESSAGING_CHANNEL_SECRET;
const ORIGINAL_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const ORIGINAL_FETCH = global.fetch;

describe('verifyWebhookSignature', () => {
  beforeEach(() => {
    process.env.LINE_LOGIN_CHANNEL_ID = 'test-line-channel-id';
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.LINE_MESSAGING_CHANNEL_SECRET;
    } else {
      process.env.LINE_MESSAGING_CHANNEL_SECRET = ORIGINAL_SECRET;
    }

    if (ORIGINAL_CHANNEL_ID === undefined) {
      delete process.env.LINE_LOGIN_CHANNEL_ID;
    } else {
      process.env.LINE_LOGIN_CHANNEL_ID = ORIGINAL_CHANNEL_ID;
    }

    global.fetch = ORIGINAL_FETCH;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns true for a valid LINE webhook signature', () => {
    process.env.LINE_MESSAGING_CHANNEL_SECRET = 'test-line-secret';
    const body = Buffer.from(JSON.stringify({ events: [] }));
    const signature = crypto
      .createHmac('sha256', process.env.LINE_MESSAGING_CHANNEL_SECRET)
      .update(body)
      .digest('base64');

    expect(verifyWebhookSignature(body, signature)).toBe(true);
  });

  it('returns false when the signature length does not match instead of throwing', () => {
    process.env.LINE_MESSAGING_CHANNEL_SECRET = 'test-line-secret';
    const body = Buffer.from(JSON.stringify({ events: [] }));

    expect(verifyWebhookSignature(body, 'invalid')).toBe(false);
  });

  it('aborts LINE token exchange requests that hang past the timeout', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })
    ) as typeof fetch;

    const request = exchangeCodeForToken('test-code');
    const assertion = expect(request).rejects.toThrow('LINE token exchange timed out after 8000ms');
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  it('returns null when LIFF token verification times out', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })
    ) as typeof fetch;

    const verification = verifyLiffAccessToken('test-access-token');
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(verification).resolves.toBeNull();
  });
});
