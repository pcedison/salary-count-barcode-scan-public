import type { Response } from 'express';
import { ZodError } from 'zod';
import { fromZodError } from 'zod-validation-error';

import { createLogger } from '../utils/logger';

const log = createLogger('api');

export function handleRouteError(err: unknown, res: Response) {
  log.error('API Error:', err);

  if (err instanceof ZodError) {
    const validationError = fromZodError(err);
    return res.status(400).json({
      message: 'Validation error',
      errors: validationError.details
    });
  }

  const isProduction = process.env.NODE_ENV === 'production';
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
  const id = Number.parseInt(value, 10);
  return Number.isNaN(id) ? null : id;
}
