import type { Express } from 'express';

import {
  PermissionLevel,
  hashPassword,
  isSuperAdminPinConfigured,
  logOperation,
  OperationType,
  verifyAdminPermission,
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
import { hashAdminPin, needsRehash } from '../utils/adminPinAuth';
import { createLogger } from '../utils/logger';
import { validatePin } from '@shared/utils/passwordValidator';

import { handleRouteError } from './route-helpers';

const log = createLogger('admin-routes');

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
      const { pin } = req.body;

      if (!pin) {
        return res.status(400).json({ success: false, message: 'PIN is required' });
      }

      const isValid = await verifyAdminPermission(pin);
      if (!isValid) {
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
        const settings = await storage.getSettings();
        if (settings?.adminPin && needsRehash(settings.adminPin)) {
          const upgraded = hashAdminPin(pin);
          await storage.createOrUpdateSettings({ ...settings, adminPin: upgraded });
          log.info('Admin PIN auto-upgraded to current PBKDF2 iteration count');
        }
      } catch (rehashErr) {
        log.error('Failed to auto-upgrade admin PIN hash:', rehashErr);
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
      return handleRouteError(err, res);
    }
  });

  app.post('/api/admin/elevate-super', loginLimiter, requireAdmin(PermissionLevel.ADMIN), async (req, res) => {
    try {
      const { pin } = req.body;

      if (!pin) {
        return res.status(400).json({ success: false, message: 'PIN is required' });
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
      return handleRouteError(err, res);
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
      const { oldPin, newPin } = req.body;

      if (!oldPin || !newPin) {
        return res.status(400).json({
          success: false,
          message: 'Old PIN and new PIN are required',
        });
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

      if (!(await verifyAdminPermission(oldPin))) {
        return res.status(401).json({
          success: false,
          message: 'Current PIN is incorrect',
        });
      }

      await storage.createOrUpdateSettings({
        ...settings,
        adminPin: hashPassword(newPin),
      });

      logOperation(OperationType.UPDATE, 'Admin PIN updated', {
        ip: req.ip,
        success: true,
      });

      return res.json({ success: true, strength: validation.strength });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });
}
