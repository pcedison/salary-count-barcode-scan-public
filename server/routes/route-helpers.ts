import type { Response } from 'express';
import { ZodError } from 'zod';
import { fromZodError } from 'zod-validation-error';

import { createLogger } from '../utils/logger';
import { PayrollWritesPausedError } from '../config/payrollWrites';

const log = createLogger('api');

export function handleRouteError(err: unknown, res: Response) {
  if (err instanceof PayrollWritesPausedError) return res.status(err.status).json({ message: err.message, code: err.code });
  const known = err as { status?: number; code?: string } | null;
  if (known?.status && known.status >= 400 && known.status < 500 && typeof known.code === 'string') {
    return res.status(known.status).json({ message: err instanceof Error ? err.message : 'Request rejected.', code: known.code });
  }

  if (err instanceof ZodError) {
    const validationError = fromZodError(err);
    return res.status(400).json({
      message: 'Validation error',
      errors: validationError.details
    });
  }

  const isProduction = process.env.NODE_ENV === 'production';
  log.error('API Error', { name: err instanceof Error ? err.name : 'UnknownError', code: known?.code });
  const message = isProduction
    ? 'Internal Server Error'
    : err instanceof Error
      ? err.message
      : 'Internal server error';

  return res.status(500).json({
    message,
    code: 'INTERNAL_ERROR'
  });
}

export function parseNumericId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
