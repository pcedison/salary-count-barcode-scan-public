import type { Express, Response } from 'express';

import {
  PermissionLevel,
  hashPasswordAsync,
  isSuperAdminPinConfigured,
  logOperation,
  OperationType,
  verifyAdminCredential,
  verifySuperAdminPermission
} from '../admin-auth';
import { loginLimiter, strictLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/requireAdmin';
import {
  clearAdminSession,
  createAdminSession,
  getAdminSessionPolicy,
  hasAdminSession,
  promoteAdminSession,
  touchAdminSession,
} from '../session';
import { recordCounter } from '../observability/runtimeMetrics';
import { storage } from '../storage';
import { AdminPinBusyError, hashAdminPinAsync, isSupportedPinInput, needsRehash, verifyStoredAdminPinAsync } from '../utils/adminPinAuth';
import { createLogger } from '../utils/logger';
import { validatePin } from '@shared/utils/passwordValidator';

import { handleRouteError } from './route-helpers';

const log = createLogger('admin-routes');

function handleAuthRouteError(error: unknown, res: Response) {
  if (error instanceof AdminPinBusyError) {
    return res.set('Retry-After', '1').status(503).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }
  return handleRouteError(error, res);
}

function buildAdminSessionPolicyPayload() {
  const policy = getAdminSessionPolicy();

  return {
    sessionTimeoutMinutes: policy.timeoutMinutes,
    sessionTimeoutMs: policy.timeoutMs,
    sessionRefreshIntervalMs: policy.refreshIntervalMs,
  };
}

export function registerAdminRoutes(app: Express): void {
  app.post('/api/verify-admin', loginLimiter, async (req, res) => {
    try {
      const { pin } = req.body || {};

      if (!pin) {
        return res.status(400).json({ success: false, message: 'PIN is required' });
      }

      if (!isSupportedPinInput(pin)) {
        return res.status(400).json({ success: false, message: 'Invalid PIN input' });
      }

      const credential = await verifyAdminCredential(pin);
      if (!credential) {
        recordCounter('admin.login.failure');
        logOperation(OperationType.LOGIN, 'Admin login failed', {
          ip: req.ip,
          success: false,
          errorMessage: 'invalid_admin_pin',
        });
        return res.json({ success: false });
      }

      // Transparent PBKDF2 iteration upgrade: re-hash with current iterations on login
      try {
        if (needsRehash(credential.storedHash)) {
          const upgraded = await hashAdminPinAsync(pin);
          if (!(await storage.compareAndSwapAdminPin(credential.storedHash, upgraded))) {
            return res.status(409).json({ success: false, code: 'AUTH_CREDENTIAL_CHANGED', message: 'Admin credential changed. Please sign in again.' });
          }
          log.info('Admin PIN auto-upgraded to current PBKDF2 iteration count');
        }
      } catch (rehashErr) {
        // A successful verification remains usable if this optional upgrade is busy.
        if (!(rehashErr instanceof AdminPinBusyError)) {
          log.error('Failed to auto-upgrade admin PIN hash', { name: rehashErr instanceof Error ? rehashErr.name : 'UnknownError' });
        }
      }

      await createAdminSession(req, PermissionLevel.ADMIN);
      logOperation(OperationType.LOGIN, 'Admin login succeeded', {
        ip: req.ip,
        success: true,
      });

      return res.json({
        success: true,
        authMode: 'session',
        permissionLevel: PermissionLevel.ADMIN,
        superAdminConfigured: isSuperAdminPinConfigured(),
        ...buildAdminSessionPolicyPayload(),
      });
    } catch (err) {
      return handleAuthRouteError(err, res);
    }
  });

  app.post('/api/admin/elevate-super', loginLimiter, requireAdmin(PermissionLevel.ADMIN), async (req, res) => {
    try {
      const { pin } = req.body || {};

      if (!pin) {
        return res.status(400).json({ success: false, message: 'PIN is required' });
      }

      if (!isSupportedPinInput(pin)) {
        return res.status(400).json({ success: false, message: 'Invalid PIN input' });
      }

      if (process.env.NODE_ENV === 'production' && !isSuperAdminPinConfigured()) {
        logOperation(OperationType.AUTHORIZATION, 'Super admin elevation rejected: SUPER_ADMIN_PIN is not configured', {
          ip: req.ip,
          success: false,
          errorMessage: 'missing_super_admin_pin'
        });
        return res.status(503).json({
          success: false,
          message: 'SUPER_ADMIN_PIN is not configured for this deployment.'
        });
      }

      const isValid = await verifySuperAdminPermission(pin);
      if (!isValid) {
        logOperation(OperationType.AUTHORIZATION, 'Super admin elevation failed', {
          ip: req.ip,
          success: false,
          errorMessage: 'invalid_super_pin',
        });
        return res.status(401).json({ success: false, message: 'Super-admin credential is incorrect' });
      }

      await promoteAdminSession(req, PermissionLevel.SUPER);
      logOperation(OperationType.AUTHORIZATION, 'Super admin elevation succeeded', {
        ip: req.ip,
        success: true,
      });

      return res.json({
        success: true,
        authMode: 'session',
        permissionLevel: PermissionLevel.SUPER,
        superAdminConfigured: isSuperAdminPinConfigured(),
        ...buildAdminSessionPolicyPayload(),
      });
    } catch (err) {
      return handleAuthRouteError(err, res);
    }
  });

  app.get('/api/admin/session', async (req, res) => {
    try {
      const isAdmin = hasAdminSession(req, PermissionLevel.ADMIN);
      if (isAdmin) {
        touchAdminSession(req);
      }

      return res.json({
        success: true,
        isAdmin,
        authMode: 'session',
        permissionLevel: isAdmin ? req.session.adminAuth?.permissionLevel : null,
        authenticatedAt: isAdmin ? req.session.adminAuth?.authenticatedAt : null,
        superAdminConfigured: isSuperAdminPinConfigured(),
        ...buildAdminSessionPolicyPayload(),
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/admin/logout', async (req, res) => {
    try {
      const hadSession = hasAdminSession(req, PermissionLevel.ADMIN);
      await clearAdminSession(req, res);

      if (hadSession) {
        logOperation(OperationType.LOGOUT, 'Admin logout', {
          ip: req.ip,
          success: true,
        });
      }

      return res.json({
        success: true,
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/update-admin-pin', strictLimiter, requireAdmin(PermissionLevel.SUPER), async (req, res) => {
    try {
      const { oldPin, newPin } = req.body || {};

      if (!oldPin || !newPin) {
        return res.status(400).json({
          success: false,
          message: 'Old PIN and new PIN are required',
        });
      }

      if (!isSupportedPinInput(oldPin) || !isSupportedPinInput(newPin)) {
        return res.status(400).json({ success: false, message: 'Invalid PIN input' });
      }

      const validation = validatePin(newPin);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: 'New PIN does not meet security requirements',
          errors: validation.errors,
        });
      }

      const settings = await storage.getSettings();
      if (!settings) {
        return res.status(404).json({ success: false, message: 'Settings not found' });
      }

      if (!(await verifyStoredAdminPinAsync(settings.adminPin || '', oldPin))) {
        return res.status(401).json({
          success: false,
          message: 'Current PIN is incorrect',
        });
      }

      const updatedPin = await hashPasswordAsync(newPin);
      if (!(await storage.compareAndSwapAdminPin(settings.adminPin, updatedPin))) {
        return res.status(409).json({ success: false, code: 'AUTH_CREDENTIAL_CHANGED', message: 'Admin credential changed. Please try again.' });
      }

      logOperation(OperationType.UPDATE, 'Admin PIN updated', {
        ip: req.ip,
        success: true,
      });

      return res.json({ success: true, strength: validation.strength });
    } catch (err) {
      return handleAuthRouteError(err, res);
    }
  });
}
