export interface PayrollReviewFinding {
  kind:
    | "company_no_clock_in"
    | "employee_no_clock_in"
    | "worked_national_holiday"
    | "unmarked_national_holiday"
    | "unmarked_rest_day_work";
  date: string;
  employeeName?: string;
  holidayName?: string;
}

export interface PendingPayrollReview {
  salaryYear: number;
  salaryMonth: number;
  findings: PayrollReviewFinding[];
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${month}/${day}（${WEEKDAY_LABELS[weekday]}）`;
}

export function describePayrollReviewFinding(finding: PayrollReviewFinding): string {
  const date = formatDate(finding.date);
  const who = finding.employeeName ?? "員工";
  const holiday = finding.holidayName ? `${finding.holidayName}` : "國定假日";
  switch (finding.kind) {
    case "company_no_clock_in":
      return `${date} 平日全公司都沒打卡，也沒標假別（颱風假？）`;
    case "employee_no_clock_in":
      return `${date} ${who}沒打卡，也沒標假別`;
    case "worked_national_holiday":
      return `${date} ${holiday}：${who}有打卡，但沒標假日出勤`;
    case "unmarked_national_holiday":
      return `${date} ${holiday}：${who}沒有任何標記`;
    case "unmarked_rest_day_work":
      return `${date} ${who}有打卡，但沒標假日出勤`;
    default:
      return date;
  }
}

function isFinding(value: unknown): value is PayrollReviewFinding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<PayrollReviewFinding>;
  return typeof finding.kind === "string" && typeof finding.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(finding.date);
}

export function isPendingPayrollReviewList(value: unknown): value is PendingPayrollReview[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== "object") return false;
      const review = item as Partial<PendingPayrollReview>;
      return (
        Number.isInteger(review.salaryYear) &&
        Number.isInteger(review.salaryMonth) &&
        Array.isArray(review.findings) &&
        review.findings.every(isFinding)
      );
    })
  );
}
