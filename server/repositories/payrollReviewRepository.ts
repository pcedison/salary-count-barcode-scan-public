import { and, asc, eq } from 'drizzle-orm';

import { payrollReviews, type PayrollReview } from '@shared/schema';

import { db } from '../db';

export interface PayrollReviewTarget {
  year: number;
  month: number;
}

/** 月結前檢查的暫停狀態。存在資料庫，因為 Cloud Run 會縮到 0，記憶體裡的狀態不可靠。 */
export class DatabasePayrollReviewRepository {
  async getReview(target: PayrollReviewTarget): Promise<PayrollReview | undefined> {
    const [review] = await db
      .select()
      .from(payrollReviews)
      .where(and(eq(payrollReviews.salaryYear, target.year), eq(payrollReviews.salaryMonth, target.month)));
    return review;
  }

  /** 建立待確認紀錄；同月份已有紀錄就沿用（兩個 tick 同時跑也只會有一筆）。 */
  async createPending(target: PayrollReviewTarget, findings: unknown[], emailText: string): Promise<PayrollReview> {
    const [created] = await db
      .insert(payrollReviews)
      .values({ salaryYear: target.year, salaryMonth: target.month, status: 'pending', findings, emailText })
      .onConflictDoNothing({ target: [payrollReviews.salaryYear, payrollReviews.salaryMonth] })
      .returning();
    if (created) return created;
    const existing = await this.getReview(target);
    if (!existing) throw new Error('Payroll review row disappeared after conflict');
    return existing;
  }

  async markNotified(id: number, at = new Date()): Promise<void> {
    await db.update(payrollReviews).set({ notifiedAt: at }).where(eq(payrollReviews.id, id));
  }

  /** 只有待確認的紀錄會被改成已確認；回傳 undefined 代表沒有待確認的紀錄。 */
  async confirm(target: PayrollReviewTarget, confirmedBy: string, at = new Date()): Promise<PayrollReview | undefined> {
    const [confirmed] = await db
      .update(payrollReviews)
      .set({ status: 'confirmed', confirmedAt: at, confirmedBy })
      .where(and(
        eq(payrollReviews.salaryYear, target.year),
        eq(payrollReviews.salaryMonth, target.month),
        eq(payrollReviews.status, 'pending'),
      ))
      .returning();
    return confirmed;
  }

  async getPendingReviews(): Promise<PayrollReview[]> {
    return db
      .select()
      .from(payrollReviews)
      .where(eq(payrollReviews.status, 'pending'))
      .orderBy(asc(payrollReviews.salaryYear), asc(payrollReviews.salaryMonth));
  }
}

export const payrollReviewRepository = new DatabasePayrollReviewRepository();
