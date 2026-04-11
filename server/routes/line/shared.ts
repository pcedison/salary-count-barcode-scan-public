import type { Request, Response } from 'express';
import { isLineConfigured } from '../../services/line.service';
import { createLogger } from '../../utils/logger';

export const log = createLogger('line-routes');

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type AuthorizedLineSession = {
  lineUserId: string;
  lineDisplayName: string;
  linePictureUrl?: string;
};

export function setNoStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
}

export function maskLineUserId(lineUserId: string): string {
  const normalized = lineUserId.trim();
  if (normalized.length <= 8) return '***';
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

export function getAuthorizedLineSession(req: Request): AuthorizedLineSession | null {
  const lineAuth = req.session?.lineAuth;
  if (lineAuth) {
    return {
      lineUserId: lineAuth.lineUserId,
      lineDisplayName: lineAuth.lineDisplayName,
      linePictureUrl: lineAuth.linePictureUrl
    };
  }

  const lineTemp = req.session?.lineTemp;
  if (!lineTemp) return null;

  return {
    lineUserId: lineTemp.lineUserId,
    lineDisplayName: lineTemp.lineDisplayName,
    linePictureUrl: lineTemp.linePictureUrl
  };
}

export function requireLineSession(req: Request, res: Response): AuthorizedLineSession | null {
  const lineSession = getAuthorizedLineSession(req);
  if (lineSession) return lineSession;

  res.setHeader('X-Line-Session-Required', 'true');
  res.status(401).json({
    success: false,
    code: 'LINE_SESSION_REQUIRED',
    error: 'LINE login session required.'
  });
  return null;
}

export function ensureConfigured(res: Response): boolean {
  if (isLineConfigured()) return true;

  res.status(503).json({
    success: false,
    code: 'LINE_NOT_CONFIGURED',
    error: 'LINE integration is not configured.'
  });
  return false;
}

export function assertAuthorizedLineUser(
  req: Request,
  res: Response,
  lineSession: AuthorizedLineSession,
  candidate: unknown
): boolean {
  if (candidate === undefined || candidate === null || candidate === '') return true;
  if (typeof candidate === 'string' && candidate === lineSession.lineUserId) return true;

  res.status(403).json({
    success: false,
    code: 'LINE_SESSION_MISMATCH',
    error: 'The LINE session does not match the requested user.'
  });
  return false;
}

export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) { reject(error); return; }
      resolve();
    });
  });
}
