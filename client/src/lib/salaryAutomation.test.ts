import { describe, expect, it } from "vitest";

import {
  buildSalaryAutomationRunRequest,
  formatSalaryMonth,
} from "./salaryAutomation";

describe("salary automation UI helpers", () => {
  it("formats the server-provided target month", () => {
    expect(formatSalaryMonth({ year: 2026, month: 7 })).toBe("2026 年 7 月");
  });

  it("builds an explicit forced rerun request with email enabled", () => {
    expect(buildSalaryAutomationRunRequest({ year: 2026, month: 7 })).toEqual({
      year: 2026,
      month: 7,
      force: true,
      sendEmail: true,
    });
  });
});
