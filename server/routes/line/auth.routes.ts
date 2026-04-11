import crypto from 'crypto';
import type { Express } from 'express';

import { lineSessionLimiter, liffClockInLimiter } from '../../middleware/rateLimiter';
import { storage } from '../../storage';
import { handleRouteError } from '../route-helpers';
import {
  exchangeCodeForToken,
  getLineLoginUrl,
  getLineProfile,
  isLineConfigured,
  verifyLiffAccessToken
} from '../../services/line.service';
import {
  log, OAUTH_STATE_TTL_MS,
  setNoStore, maskLineUserId, requireLineSession, ensureConfigured, saveSession
} from './shared';

export function registerLineAuthRoutes(app: Express): void {
  app.get('/api/line/config', (_req, res) => {
    setNoStore(res);
    res.json({ configured: isLineConfigured() });
  });

  app.get('/api/line/login', lineSessionLimiter, async (_req, res) => {
    if (!ensureConfigured(res)) return;
    try {
      const state = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
      await storage.createOAuthState({ state, expiresAt });
      return res.redirect(getLineLoginUrl(state));
    } catch (err) {
      log.error('Failed to start LINE login flow', err);
      return handleRouteError(err, res);
    }
  });

  app.get('/api/line/callback', async (req, res) => {
    if (!isLineConfigured()) {
      return res.redirect('/clock-in?error=line_not_configured');
    }
    const { code, state, error } = req.query as Record<string, string>;
    if (error) return res.redirect('/clock-in?error=line_auth_failed');
    if (!code || !state) return res.redirect('/clock-in?error=missing_params');

    try {
      const storedState = await storage.getOAuthState(state);
      if (!storedState) return res.redirect('/clock-in?error=invalid_state');
      if (new Date() > storedState.expiresAt) {
        await storage.deleteOAuthState(state);
        return res.redirect('/clock-in?error=state_expired');
      }
      await storage.deleteOAuthState(state);

      const tokenData = await exchangeCodeForToken(code);
      const profile = await getLineProfile(tokenData.access_token);

      req.session.lineAuth = {
        lineUserId: profile.userId,
        lineDisplayName: profile.displayName,
        linePictureUrl: profile.pictureUrl,
        authenticatedAt: Date.now()
      };
      req.session.lineTemp = {
        lineUserId: profile.userId,
        lineDisplayName: profile.displayName,
        linePictureUrl: profile.pictureUrl
      };
      await saveSession(req);
      return res.redirect('/clock-in');
    } catch (err) {
      log.error('LINE callback failed', err);
      return res.redirect('/clock-in?error=callback_failed');
    }
  });

  app.get('/api/line/temp-data', lineSessionLimiter, (req, res) => {
    setNoStore(res);
    const lineSession = requireLineSession(req, res);
    if (!lineSession) return;
    res.json(lineSession);
  });

  app.post('/api/line/liff-auth', liffClockInLimiter, async (req, res) => {
    if (!ensureConfigured(res)) return;
    const { accessToken } = req.body as { accessToken?: string };
    if (!accessToken || typeof accessToken !== 'string') {
      return res.status(400).json({
        success: false,
        code: 'MISSING_TOKEN',
        error: 'LIFF access token required.'
      });
    }

    try {
      const profile = await verifyLiffAccessToken(accessToken);
      if (!profile) {
        return res.status(401).json({
          success: false,
          code: 'INVALID_TOKEN',
          error: 'Invalid or expired LIFF access token.'
        });
      }

      req.session.lineAuth = {
        lineUserId: profile.userId,
        lineDisplayName: profile.displayName,
        linePictureUrl: profile.pictureUrl,
        authenticatedAt: Date.now()
      };
      req.session.lineTemp = {
        lineUserId: profile.userId,
        lineDisplayName: profile.displayName,
        linePictureUrl: profile.pictureUrl
      };
      await saveSession(req);

      // Return binding status in the same response to save a second round-trip
      const boundEmployee = await storage.getEmployeeByLineUserId(profile.userId);
      let bindingStatus: 'bound' | 'pending' | 'unbound' = 'unbound';
      let employeeName: string | undefined;

      if (boundEmployee) {
        bindingStatus = 'bound';
        employeeName = boundEmployee.name;
      } else {
        const pending = await storage.getPendingBindingByLineUserId(profile.userId);
        if (pending && pending.status === 'pending') bindingStatus = 'pending';
      }

      log.info(`LIFF auth successful for ${maskLineUserId(profile.userId)}, binding: ${bindingStatus}`);
      return res.json({
        success: true,
        lineUserId: profile.userId,
        lineDisplayName: profile.displayName,
        linePictureUrl: profile.pictureUrl,
        bindingStatus,
        employeeName
      });
    } catch (err) {
      log.error('LIFF auth failed', err);
      return handleRouteError(err, res);
    }
  });
}
