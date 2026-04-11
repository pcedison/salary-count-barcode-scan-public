import crypto from 'crypto';
import express from 'express';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../../test-utils/http-test-server';

let registerLineWebhookRoutes: typeof import('./webhook.routes').registerLineWebhookRoutes;

beforeAll(async () => {
  ({ registerLineWebhookRoutes } = await import('./webhook.routes'));
});

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.LINE_LOGIN_CHANNEL_ID = 'line-channel-id';
  process.env.LINE_LOGIN_CHANNEL_SECRET = 'line-channel-secret';
  process.env.LINE_LOGIN_CALLBACK_URL = 'https://example.com/api/line/callback';
  process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN = 'line-access-token';
  process.env.LINE_MESSAGING_CHANNEL_SECRET = 'line-messaging-secret';
});

afterEach(() => {
  delete process.env.LINE_LOGIN_CHANNEL_ID;
  delete process.env.LINE_LOGIN_CHANNEL_SECRET;
  delete process.env.LINE_LOGIN_CALLBACK_URL;
  delete process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_MESSAGING_CHANNEL_SECRET;
});

async function createRawWebhookServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/line/webhook', express.raw({ type: 'application/json' }));
  await registerLineWebhookRoutes(app);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine webhook test server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      })
  };
}

function signBody(body: string): string {
  return crypto
    .createHmac('sha256', process.env.LINE_MESSAGING_CHANNEL_SECRET!)
    .update(Buffer.from(body))
    .digest('base64');
}

describe('line webhook routes integration', () => {
  it('rejects parsed JSON bodies that are not raw buffers', async () => {
    const server = await createJsonTestServer(registerLineWebhookRoutes);

    try {
      const body = JSON.stringify({
        events: [{ type: 'message', timestamp: Date.now(), webhookEventId: 'evt-raw' }]
      });
      const signature = signBody(body);

      const result = await jsonRequest<{ error: string }>(server.baseUrl, '/api/line/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-line-signature': signature
        },
        body
      });

      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({
        error: 'Webhook body must be a raw Buffer'
      });
    } finally {
      await server.close();
    }
  });

  it('rejects LINE webhooks with an invalid signature', async () => {
    const server = await createRawWebhookServer();

    try {
      const body = JSON.stringify({
        events: [{ type: 'message', timestamp: Date.now(), webhookEventId: 'evt-invalid' }]
      });

      const response = await fetch(`${server.baseUrl}/api/line/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-line-signature': 'invalid-signature'
        },
        body
      });

      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('accepts valid LINE webhook payloads with a fresh event', async () => {
    const server = await createRawWebhookServer();

    try {
      const body = JSON.stringify({
        events: [
          {
            type: 'message',
            timestamp: Date.now(),
            webhookEventId: 'evt-success'
          }
        ]
      });
      const signature = signBody(body);

      const response = await fetch(`${server.baseUrl}/api/line/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-line-signature': signature
        },
        body
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('OK');
    } finally {
      await server.close();
    }
  });

  it('acks stale LINE events while discarding them from processing', async () => {
    const server = await createRawWebhookServer();

    try {
      const body = JSON.stringify({
        events: [
          {
            type: 'message',
            timestamp: Date.now() - 10 * 60 * 1000,
            webhookEventId: 'evt-stale'
          }
        ]
      });
      const signature = signBody(body);

      const response = await fetch(`${server.baseUrl}/api/line/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-line-signature': signature
        },
        body
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('OK');
    } finally {
      await server.close();
    }
  });
});
