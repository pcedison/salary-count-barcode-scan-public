import type { Express } from 'express';

import { recordCounter } from '../../observability/runtimeMetrics';
import { isLineConfigured, verifyWebhookSignature } from '../../services/line.service';
import { log } from './shared';

const MAX_EVENT_AGE_MS = 5 * 60 * 1000;

export function registerLineWebhookRoutes(app: Express): void {
  app.post('/api/line/webhook', (req, res) => {
    if (!isLineConfigured()) {
      return res.status(503).json({
        success: false,
        code: 'LINE_NOT_CONFIGURED',
        error: 'LINE integration is not configured.'
      });
    }

    const signature = req.headers['x-line-signature'];
    if (!signature || typeof signature !== 'string') {
      return res.status(400).json({ error: 'Missing LINE webhook signature' });
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body)) {
      return res.status(400).json({ error: 'Webhook body must be a raw Buffer' });
    }

    if (!verifyWebhookSignature(body, signature)) {
      recordCounter('line.webhook.invalid_signature');
      log.warn('Rejected LINE webhook with invalid signature');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    try {
      const parsed = JSON.parse(body.toString());
      const events: Array<{ type?: string; timestamp?: number; webhookEventId?: string }> =
        parsed.events ?? [];
      const now = Date.now();

      const freshEvents = events.filter((event) => {
        if (typeof event.timestamp !== 'number') {
          return true;
        }

        if (Math.abs(now - event.timestamp) > MAX_EVENT_AGE_MS) {
          recordCounter('line.webhook.stale_event');
          log.warn('Discarding stale LINE webhook event', {
            eventId: event.webhookEventId,
            type: event.type,
            ageMs: now - event.timestamp
          });
          return false;
        }

        return true;
      });

      log.info(`Received ${freshEvents.length}/${events.length} LINE webhook event(s) (fresh/total)`);
    } catch {
      // Ignore parse errors after signature verification and acknowledge anyway.
    }

    return res.sendStatus(200);
  });
}
