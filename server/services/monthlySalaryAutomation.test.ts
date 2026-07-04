import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  salaryRuns: [] as Array<Record<string, any>>,
  salaryRecords: [] as Array<Record<string, any>>,
  employees: [
    {
      id: 9,
      name: 'Payroll User',
      active: true,
      deletedAt: null,
      specialLeaveUsedDates: [],
      specialLeaveCashDays: 0,
      specialLeaveCashMonth: null,
      specialLeaveNotes: null,
    },
  ],
  attendance: [
    {
      id: 1,
      employeeId: 9,
      date: '2026/04/01',
      clockIn: '09:00',
      clockOut: '18:00',
      isHoliday: false,
      holidayType: null,
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
    },
  ],
  settings: {
    id: 1,
    baseHourlyRate: 119,
    ot1Multiplier: 1.34,
    ot2Multiplier: 1.67,
    baseMonthSalary: 30000,
    welfareAllowance: 500,
    deductions: [],
    allowances: [{ name: '福利津貼', amount: 500 }],
    adminPin: 'hashed-pin',
  },
}));

const storageMock = vi.hoisted(() => ({
  updateMonthlySalaryRun: vi.fn(async (id: number, data: Record<string, any>) => {
    const run = state.salaryRuns.find((item) => item.id === id);
    if (!run) return undefined;
    Object.assign(run, data);
    return run;
  }),
  getSalaryRecordsByYearMonth: vi.fn(async (year: number, month: number) =>
    state.salaryRecords.filter((record) => record.salaryYear === year && record.salaryMonth === month)
  ),
  getSalaryRecordByYearMonthEmployee: vi.fn(async (year: number, month: number, employeeId: number) =>
    state.salaryRecords.find(
      (record) =>
        record.salaryYear === year &&
        record.salaryMonth === month &&
        record.employeeId === employeeId
    )
  ),
  getSettings: vi.fn(async () => state.settings),
  getAllEmployees: vi.fn(async () => state.employees),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(async (employeeId: number) =>
    state.attendance.filter((record) => record.employeeId === employeeId)
  ),
  getTemporaryAttendanceByMonth: vi.fn(async () => state.attendance),
  createSalaryRecord: vi.fn(async (record: Record<string, any>) => {
    const created = { ...record, id: state.salaryRecords.length + 1, createdAt: new Date() };
    state.salaryRecords.push(created);
    return created;
  }),
  updateSalaryRecord: vi.fn(async (id: number, data: Record<string, any>) => {
    const record = state.salaryRecords.find((item) => item.id === id);
    if (!record) return undefined;
    Object.assign(record, data);
    return record;
  }),
  saveSalaryRecordsAtomically: vi.fn(
    async (items: Array<{ existingId?: number; record: Record<string, any> }>) =>
      items.map((item) => {
        if (item.existingId != null) {
          const existing = state.salaryRecords.find((record) => record.id === item.existingId);
          if (existing) {
            Object.assign(existing, item.record);
            return existing;
          }
        }
        const created = {
          ...item.record,
          id: state.salaryRecords.length + 1,
          createdAt: new Date(),
        };
        state.salaryRecords.push(created);
        return created;
      })
  ),
}));

const monthlySalaryRunRepositoryMock = vi.hoisted(() => ({
  acquireRun: vi.fn(
    async (params: {
      year: number;
      month: number;
      runKey: string;
      force: boolean;
      emailRecipients: string[];
    }) => {
      const existing = state.salaryRuns.find(
        (run) => run.salaryYear === params.year && run.salaryMonth === params.month
      );

      if (existing?.status === 'succeeded' && !params.force) {
        return { run: existing, skipReason: 'monthly salary run already succeeded' };
      }

      if (existing?.status === 'running' && !params.force) {
        return { run: existing, skipReason: 'monthly salary run is already running' };
      }

      if (existing) {
        Object.assign(existing, {
          status: 'running',
          recordCount: 0,
          skippedCount: 0,
          pdfPath: null,
          emailTo: params.emailRecipients,
          emailSentAt: null,
          errorMessage: null,
          completedAt: null,
        });
        return { run: existing };
      }

      const created = {
        id: state.salaryRuns.length + 1,
        runKey: params.runKey,
        salaryYear: params.year,
        salaryMonth: params.month,
        status: 'running',
        recordCount: 0,
        skippedCount: 0,
        emailTo: params.emailRecipients,
        startedAt: new Date(),
      };
      state.salaryRuns.push(created);
      return { run: created };
    }
  ),
}));

const buildCalculatedSalaryRecord = vi.hoisted(() =>
  vi.fn(async (draft: Record<string, any>) => ({
    ...draft,
    totalOvertimePay: 100,
    grossSalary: draft.baseSalary + (draft.welfareAllowance ?? 0) + 100,
    netSalary: draft.baseSalary + (draft.welfareAllowance ?? 0) + 100,
  }))
);

const generateMonthlySalaryPdf = vi.hoisted(() => vi.fn(async () => '/tmp/salary.pdf'));
const sendMonthlySalaryEmail = vi.hoisted(() =>
  vi.fn(async () => ({ recipients: ['payroll@example.com'], messageId: 'message-1' }))
);

vi.mock('../storage', () => ({ storage: storageMock }));
vi.mock('../repositories/monthlySalaryRunRepository', () => ({
  monthlySalaryRunRepository: monthlySalaryRunRepositoryMock,
}));
vi.mock('../routes/salary.routes', () => ({ buildCalculatedSalaryRecord }));
vi.mock('./salaryPdf', () => ({ generateMonthlySalaryPdf }));
vi.mock('./salaryEmail', () => ({ sendMonthlySalaryEmail }));

let moduleUnderTest: typeof import('./monthlySalaryAutomation');

beforeAll(async () => {
  moduleUnderTest = await import('./monthlySalaryAutomation');
});

beforeEach(() => {
  state.salaryRuns = [];
  state.salaryRecords = [];
  vi.clearAllMocks();
});

describe('monthly salary automation', () => {
  it('selects the previous salary month across a year boundary', () => {
    expect(moduleUnderTest.getPreviousSalaryMonthTarget(new Date('2026-01-02T00:00:00.000Z'), 'UTC')).toEqual({
      year: 2025,
      month: 12,
    });
  });

  it('waits until the configured local run time on the first day of the month', () => {
    const config = {
      enabled: true,
      timeZone: 'UTC',
      runHour: 1,
      runMinute: 15,
      intervalMs: 3600000,
      emailRecipients: [],
      smtpPort: 587,
      smtpSecure: false,
    };

    expect(moduleUnderTest.shouldRunMonthlySalaryAutomation(new Date('2026-05-01T01:14:00.000Z'), config)).toBe(false);
    expect(moduleUnderTest.shouldRunMonthlySalaryAutomation(new Date('2026-05-01T01:15:00.000Z'), config)).toBe(true);
  });

  it('supports dry runs without creating records, PDFs, or email', async () => {
    const result = await moduleUnderTest.runMonthlySalaryAutomation({
      target: { year: 2026, month: 4 },
      dryRun: true,
      config: {
        enabled: false,
        timeZone: 'UTC',
        runHour: 1,
        runMinute: 15,
        intervalMs: 3600000,
        emailRecipients: [],
        smtpPort: 587,
        smtpSecure: false,
      },
    });

    expect(result.status).toBe('dry-run');
    expect(result.calculatedRecords).toHaveLength(1);
    expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
    expect(generateMonthlySalaryPdf).not.toHaveBeenCalled();
    expect(sendMonthlySalaryEmail).not.toHaveBeenCalled();
  });

  it('preloads month data with fixed query count and persists records in a single atomic batch', async () => {
    // 防 N+1 迴歸:不論員工數多寡,查詢次數固定;寫入必須走單一 transaction 批次,
    // 中途失敗時不得留下半套薪資資料。
    state.employees.push({
      id: 10,
      name: 'Second User',
      active: true,
      deletedAt: null,
      specialLeaveUsedDates: [],
      specialLeaveCashDays: 0,
      specialLeaveCashMonth: null,
      specialLeaveNotes: null,
    });
    state.attendance.push({
      id: 2,
      employeeId: 10,
      date: '2026/04/02',
      clockIn: '09:00',
      clockOut: '18:00',
      isHoliday: false,
      holidayType: null,
      createdAt: new Date('2026-04-02T00:00:00.000Z'),
    });

    try {
      const result = await moduleUnderTest.runMonthlySalaryAutomation({
        target: { year: 2026, month: 4 },
        sendEmail: false,
        config: {
          enabled: true,
          timeZone: 'UTC',
          runHour: 1,
          runMinute: 15,
          intervalMs: 3600000,
          emailRecipients: [],
          smtpPort: 587,
          smtpSecure: false,
        },
      });

      expect(result.status).toBe('succeeded');
      expect(result.persistedRecords).toHaveLength(2);

      // 整月資料一次預載,而非每員工各查一次
      expect(storageMock.getSalaryRecordsByYearMonth).toHaveBeenCalledTimes(1);
      expect(storageMock.getTemporaryAttendanceByMonth).toHaveBeenCalledTimes(1);
      expect(storageMock.getTemporaryAttendanceByMonth).toHaveBeenCalledWith(2026, 4);
      expect(storageMock.getSalaryRecordByYearMonthEmployee).not.toHaveBeenCalled();
      expect(storageMock.getTemporaryAttendanceByEmployeeAndMonth).not.toHaveBeenCalled();

      // 全部寫入集中於單一原子批次
      expect(storageMock.saveSalaryRecordsAtomically).toHaveBeenCalledTimes(1);
      expect(storageMock.saveSalaryRecordsAtomically).toHaveBeenCalledWith([
        expect.objectContaining({ record: expect.objectContaining({ employeeId: 9 }) }),
        expect.objectContaining({ record: expect.objectContaining({ employeeId: 10 }) }),
      ]);
      expect(storageMock.createSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
    } finally {
      state.employees.pop();
      state.attendance.pop();
    }
  });

  it('persists the monthly run, PDF path, and sent email metadata', async () => {
    const result = await moduleUnderTest.runMonthlySalaryAutomation({
      target: { year: 2026, month: 4 },
      config: {
        enabled: true,
        timeZone: 'UTC',
        runHour: 1,
        runMinute: 15,
        intervalMs: 3600000,
        emailRecipients: ['payroll@example.com'],
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecure: false,
        smtpFrom: 'Payroll <payroll@example.com>',
      },
    });

    expect(result.status).toBe('succeeded');
    expect(result.persistedRecords).toHaveLength(1);
    expect(generateMonthlySalaryPdf).toHaveBeenCalledWith(
      { year: 2026, month: 4 },
      expect.arrayContaining([expect.objectContaining({ employeeId: 9 })]),
      expect.any(Object)
    );
    expect(sendMonthlySalaryEmail).toHaveBeenCalledTimes(1);
    expect(storageMock.updateMonthlySalaryRun).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        status: 'succeeded',
        recordCount: 1,
        pdfPath: '/tmp/salary.pdf',
        emailTo: ['payroll@example.com'],
      })
    );
  });
});
