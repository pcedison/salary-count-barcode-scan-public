import { describe, expect, it } from "vitest";

import { describePayrollReviewFinding, isPendingPayrollReviewList } from "./payrollReview";

describe("payroll review helpers", () => {
  it("describes findings in plain Chinese with the weekday", () => {
    expect(
      describePayrollReviewFinding({ kind: "unmarked_rest_day_work", date: "2026-11-14", employeeName: "陳文山" }),
    ).toBe("11/14（六） 陳文山有打卡，但沒標假日出勤");
    expect(describePayrollReviewFinding({ kind: "company_no_clock_in", date: "2026-11-18" })).toContain("颱風假");
  });

  it("accepts only well-formed pending review lists", () => {
    expect(
      isPendingPayrollReviewList([
        { salaryYear: 2026, salaryMonth: 11, findings: [{ kind: "company_no_clock_in", date: "2026-11-18" }] },
      ]),
    ).toBe(true);
    expect(isPendingPayrollReviewList([{ salaryYear: 2026, salaryMonth: 11 }])).toBe(false);
    expect(isPendingPayrollReviewList({})).toBe(false);
  });
});
