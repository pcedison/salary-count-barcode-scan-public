import type { Express } from 'express';

import { registerLineAuthRoutes } from './line/auth.routes';
import { registerLineBindRoutes } from './line/bind.routes';
import { registerLineClockInRoutes } from './line/clockin.routes';
import { registerLineWebhookRoutes } from './line/webhook.routes';

export function registerLineRoutes(app: Express): void {
  registerLineAuthRoutes(app);
  registerLineBindRoutes(app);
  registerLineClockInRoutes(app);
  registerLineWebhookRoutes(app);
}
