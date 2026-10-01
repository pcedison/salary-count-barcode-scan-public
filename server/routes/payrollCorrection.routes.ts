import type { Express, Request } from 'express';
import { z } from 'zod';
import { requirePayrollWrite } from '../middleware/payrollRequest';
export { requirePayrollWrite } from '../middleware/payrollRequest';
import { payrollCorrectionRequestSchema } from '@shared/payrollCorrection';
import { PermissionLevel } from '../admin-auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { salaryRepository } from '../repositories/salaryRepository';
import { buildPayrollHolidayCorrection, PayrollCorrectionError } from '../services/payrollCorrection';
import { createPayrollPreviewToken, payrollActorId, payrollHash, verifyPayrollPreviewToken } from '../services/payrollPreviewToken';
import { handleRouteError, parseNumericId } from './route-helpers';

const previewSchema = payrollCorrectionRequestSchema.extend({ revision: z.number().int().nonnegative() }).strict();
const confirmSchema = previewSchema.extend({ previewToken: z.string().min(1).max(2048), idempotencyKey: z.string().uuid() }).strict();
export function correctionActor(req: Request) {
  if (!req.sessionID) throw new PayrollCorrectionError(401, 'SESSION_REQUIRED', 'An authenticated administrator session is required.');
  return { actorId: payrollActorId(req.sessionID), actorRole: PermissionLevel[req.session.adminAuth?.permissionLevel ?? PermissionLevel.ADMIN] };
}
export function publicCorrection(correction: Awaited<ReturnType<typeof salaryRepository.getSalaryCorrections>>[number]) {
  return { id: correction.id, revision: correction.revision, reason: correction.reason, paymentHandling: correction.paymentHandling, delta: correction.delta, holidays: correction.holidays, createdAt: correction.createdAt, actorRole: correction.actorRole };
}
export function registerPayrollCorrectionRoutes(app: Express): void {
  app.get('/api/salary-records/:id/holiday-corrections', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) return res.status(400).json({ message: 'Invalid ID.' });
      if (!await salaryRepository.getSalaryRecordById(id)) return res.status(404).json({ message: 'Salary record not found.' });
      return res.json({ corrections: (await salaryRepository.getSalaryCorrections(id)).map(publicCorrection) });
    } catch (error) { return handleRouteError(error, res); }
  });
  app.post('/api/salary-records/:id/holiday-corrections/preview', requireAdmin(), requirePayrollWrite, async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) return res.status(400).json({ message: 'Invalid ID.' });
      const request = previewSchema.parse(req.body);
      const record = await salaryRepository.getSalaryRecordById(id);
      if (!record) return res.status(404).json({ message: 'Salary record not found.' });
      if (request.revision !== (record.revision ?? 0)) throw new PayrollCorrectionError(409, 'REVISION_CONFLICT', 'Salary record changed; reload and preview again.');
      const actor = correctionActor(req);
      const { revision: _revision, ...changes } = request;
      const preview = buildPayrollHolidayCorrection(record, changes);
      return res.json({ ...preview, previewToken: createPayrollPreviewToken(record, request, actor.actorId) });
    } catch (error) { return handleRouteError(error, res); }
  });
  app.post('/api/salary-records/:id/holiday-corrections', requireAdmin(), requirePayrollWrite, async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) return res.status(400).json({ message: 'Invalid ID.' });
      const { previewToken, idempotencyKey, ...request } = confirmSchema.parse(req.body);
      const actor = correctionActor(req);
      const result = await salaryRepository.commitSalaryCorrection(id, { ...actor, idempotencyKey, requestHash: payrollHash(request), previewTokenHash: payrollHash(previewToken) }, record => {
        if (!verifyPayrollPreviewToken(previewToken, record, request, actor.actorId)) throw new PayrollCorrectionError(409, 'PREVIEW_EXPIRED_OR_CHANGED', 'The preview expired or the salary record changed; reload and preview again.');
        const { revision: _revision, ...changes } = request;
        return buildPayrollHolidayCorrection(record, changes);
      });
      return res.json({ ...result, correction: publicCorrection(result.correction) });
    } catch (error) { return handleRouteError(error, res); }
  });
}
