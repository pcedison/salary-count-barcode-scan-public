import { and, eq, ne } from 'drizzle-orm';

import {
  monthlySalaryRuns,
  type InsertMonthlySalaryRun,
  type MonthlySalaryRun,
} from '@shared/schema';

import { db } from '../db';

export interface AcquireMonthlySalaryRunParams {
  year: number;
  month: number;
  runKey: string;
  force: boolean;
  emailRecipients: string[];
}

export interface AcquireMonthlySalaryRunResult {
  run?: MonthlySalaryRun;
  skipReason?: string;
}

export class DatabaseMonthlySalaryRunRepository {
  /**
   * Atomically creates the run row for (year, month) or, if one already exists,
   * updates it to `running` — unless it's already `running` or `succeeded` (and
   * `force` isn't set), in which case the row is left untouched and a
   * `skipReason` is returned. This is a single INSERT ... ON CONFLICT statement,
   * so two concurrent callers can never both acquire the same month.
   */
  async acquireRun(params: AcquireMonthlySalaryRunParams): Promise<AcquireMonthlySalaryRunResult> {
    const { year, month, runKey, force, emailRecipients } = params;

    const insertValues: InsertMonthlySalaryRun = {
      runKey,
      salaryYear: year,
      salaryMonth: month,
      status: 'running',
      recordCount: 0,
      skippedCount: 0,
      emailTo: emailRecipients,
    };

    const updateSet: Partial<MonthlySalaryRun> = {
      status: 'running',
      recordCount: 0,
      skippedCount: 0,
      pdfPath: null,
      emailTo: emailRecipients,
      emailSentAt: null,
      errorMessage: null,
      completedAt: null,
    };

    const rows = await db
      .insert(monthlySalaryRuns)
      .values(insertValues)
      .onConflictDoUpdate({
        target: [monthlySalaryRuns.salaryYear, monthlySalaryRuns.salaryMonth],
        set: updateSet,
        ...(force
          ? {}
          : {
              setWhere: and(
                ne(monthlySalaryRuns.status, 'running'),
                ne(monthlySalaryRuns.status, 'succeeded')
              )!,
            }),
      })
      .returning();

    const [run] = rows;

    if (run) {
      return { run };
    }

    const [existingRun] = await db
      .select()
      .from(monthlySalaryRuns)
      .where(and(eq(monthlySalaryRuns.salaryYear, year), eq(monthlySalaryRuns.salaryMonth, month)));

    return {
      run: existingRun,
      skipReason:
        existingRun?.status === 'succeeded'
          ? 'monthly salary run already succeeded'
          : 'monthly salary run is already running',
    };
  }
}

export const monthlySalaryRunRepository = new DatabaseMonthlySalaryRunRepository();
