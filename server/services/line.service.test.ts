import crypto from 'crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from './line.service';

const ORIGINAL_SECRET = process.env.LINE_MESSAGING_CHANNEL_SECRET;

describe('verifyWebhookSignature', () => {
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.LINE_MESSAGING_CHANNEL_SECRET;
      return;
    }

    process.env.LINE_MESSAGING_CHANNEL_SECRET = ORIGINAL_SECRET;
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
});
