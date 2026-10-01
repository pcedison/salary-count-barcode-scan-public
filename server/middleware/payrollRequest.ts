import type { Request, Response, NextFunction } from 'express';

export function requirePayrollWrite(req: Request, res: Response, next: NextFunction) {
  if (!req.is('application/json')) return res.status(415).json({ message: 'Payroll writes require JSON.' });
  const origin = req.get('Origin');
  if (req.get('Sec-Fetch-Site') === 'cross-site' || (origin && origin !== `${req.protocol}://${req.get('host')}`)) {
    return res.status(403).json({ message: 'Cross-origin payroll writes are not allowed.', code: 'CROSS_ORIGIN_PAYROLL_WRITE' });
  }
  next();
}
