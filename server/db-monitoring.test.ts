import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@shared/schema';
import {
  AUTHORITATIVE_RESTORE_DELETE_ORDER,
  AUTHORITATIVE_RESTORE_INSERT_ORDER,
  AUTHORITATIVE_SEQUENCE_TABLES,
  AUTHORITATIVE_TABLE_NAMES,
  BACKUP_AUTHORITY_VERSION,
  EXCLUDED_BACKUP_TABLES
} from './backup-authority';
import { BackupType, createDatabaseBackup, validateBackupId } from './db-monitoring';

const executeMock = vi.hoisted(() => vi.fn(async () => []));
const selectFromMock = vi.hoisted(() => vi.fn(async () => []));
const selectMock = vi.hoisted(() =>
  vi.fn(() => ({
    from: selectFromMock
  }))
);
const deleteMock = vi.hoisted(() => vi.fn(async () => []));
const txDeleteMock = vi.hoisted(() => vi.fn(async () => []));
const txExecuteMock = vi.hoisted(() => vi.fn(async () => []));
const txInsertValuesMock = vi.hoisted(() => vi.fn(async () => []));
const txInsertMock = vi.hoisted(() =>
  vi.fn(() => ({
    values: txInsertValuesMock
  }))
);
const transactionMock = vi.hoisted(() =>
  vi.fn(async (callback: (tx: { delete: typeof txDeleteMock; insert: typeof txInsertMock; execute: typeof txExecuteMock }) => unknown) =>
    callback({
      delete: txDeleteMock,
      insert: txInsertMock,
      execute: txExecuteMock
    })
  )
);
const getAllEmployeesMock = vi.hoisted(() => vi.fn(async () => []));
const getSettingsMock = vi.hoisted(() => vi.fn(async () => null));
const getAllHolidaysMock = vi.hoisted(() => vi.fn(async () => []));
const getAllSalaryRecordsMock = vi.hoisted(() => vi.fn(async () => []));
const getTemporaryAttendanceMock = vi.hoisted(() => vi.fn(async () => []));
const createEmployeeMock = vi.hoisted(() => vi.fn());
const createOrUpdateSettingsMock = vi.hoisted(() => vi.fn());
const createHolidayMock = vi.hoisted(() => vi.fn());
const createSalaryRecordMock = vi.hoisted(() => vi.fn());
const createTemporaryAttendanceMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => true));
const mkdirSyncMock = vi.hoisted(() => vi.fn());
const readdirSyncMock = vi.hoisted(() => vi.fn(() => []));
const statSyncMock = vi.hoisted(() =>
  vi.fn(() => ({
    mtime: new Date('2026-03-14T00:00:00.000Z'),
    size: 0
  }))
);
const unlinkSyncMock = vi.hoisted(() => vi.fn());
const accessMock = vi.hoisted(() => vi.fn(async () => undefined));
const mkdirMock = vi.hoisted(() => vi.fn(async () => undefined));
const writeFileMock = vi.hoisted(() => vi.fn(async () => undefined));
const readdirMock = vi.hoisted(() => vi.fn(async () => []));
const statMock = vi.hoisted(() =>
  vi.fn(async () => ({
    mtime: new Date('2026-03-14T00:00:00.000Z'),
    size: 0
  }))
);
const unlinkMock = vi.hoisted(() => vi.fn(async () => undefined));
const readFileSyncMock = vi.hoisted(() => vi.fn(() => '{}'));
const readFileMock = vi.hoisted(() => vi.fn(async () => '{}'));
const writtenBackupContents = vi.hoisted(() => new Map<string, string>());

vi.mock('./db', () => ({
  db: {
    execute: executeMock,
    select: selectMock,
    delete: deleteMock,
    transaction: transactionMock
  }
}));

vi.mock('./storage', () => ({
  storage: {
    getAllEmployees: getAllEmployeesMock,
    getAllEmployeesIncludingDeleted: getAllEmployeesMock,
    getSettings: getSettingsMock,
    getAllHolidays: getAllHolidaysMock,
    getAllSalaryRecords: getAllSalaryRecordsMock,
    getTemporaryAttendance: getTemporaryAttendanceMock,
    createEmployee: createEmployeeMock,
    createOrUpdateSettings: createOrUpdateSettingsMock,
    createHoliday: createHolidayMock,
    createSalaryRecord: createSalaryRecordMock,
    createTemporaryAttendance: createTemporaryAttendanceMock
  }
}));

vi.mock('./utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    readdirSync: readdirSyncMock,
    statSync: statSyncMock,
    unlinkSync: unlinkSyncMock,
    readFileSync: readFileSyncMock,
    promises: {
      access: accessMock,
      mkdir: mkdirMock,
      writeFile: writeFileMock,
      readdir: readdirMock,
      stat: statMock,
      unlink: unlinkMock,
      readFile: readFileMock,
      appendFile: vi.fn(async () => undefined)
    }
  }
}));

import {
  inspectBackupFileAtPath,
  inspectBackupFile,
  getBackupsList,
  rehearseRestoreFromBackup,
  deleteBackup,
  restoreFromBackup,
  setupAutomaticBackups,
  startMonitoring,
  stopAutomaticBackups,
  stopMonitoring
} from './db-monitoring';

function buildAuthorityMetadata() {
  return {
    authorityVersion: BACKUP_AUTHORITY_VERSION,
    authoritativeTables: [...AUTHORITATIVE_TABLE_NAMES],
    excludedTables: EXCLUDED_BACKUP_TABLES.map((table) => ({ ...table }))
  };
}

function getSchemaTableForPayloadKey(payloadKey: (typeof AUTHORITATIVE_RESTORE_DELETE_ORDER)[number]) {
  switch (payloadKey) {
    case 'employees':
      return schema.employees;
    case 'settings':
      return schema.settings;
    case 'pendingBindings':
      return schema.pendingBindings;
    case 'holidays':
      return schema.holidays;
    case 'salaryRecords':
      return schema.salaryRecords;
    case 'temporaryAttendance':
      return schema.temporaryAttendance;
    case 'calculationRules':
      return schema.calculationRules;
    case 'taiwanHolidays':
      return schema.taiwanHolidays;
  }
}

describe('db-monitoring scheduler guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    existsSyncMock.mockImplementation(() => true);
    readFileSyncMock.mockReturnValue('{}');
    readdirSyncMock.mockReturnValue([]);
    accessMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    readdirMock.mockResolvedValue([]);
    statMock.mockResolvedValue({
      mtime: new Date('2026-03-14T00:00:00.000Z'),
      size: 0
    });
    unlinkMock.mockResolvedValue(undefined);
    writtenBackupContents.clear();
    delete process.env.ENCRYPTION_KEY;
    delete process.env.BACKUP_ENCRYPTION_KEY;
    stopMonitoring();
    stopAutomaticBackups();
  });

  afterEach(() => {
    stopMonitoring();
    stopAutomaticBackups();
    vi.restoreAllMocks();
  });

  it('starts monitoring only once when called repeatedly', async () => {
    const timer = { kind: 'monitor-timer' } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    const first = startMonitoring(5000);
    const second = startMonitoring(5000);

    await Promise.resolve();
    await Promise.resolve();

    expect(first).toBe(timer);
    expect(second).toBe(timer);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledTimes(1);

    stopMonitoring();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it('starts automatic backups only once and avoids duplicate bootstrap backups', async () => {
    const timer = { kind: 'backup-timer' } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    const first = setupAutomaticBackups();
    const second = setupAutomaticBackups();

    await Promise.resolve();
    await Promise.resolve();

    expect(first).toBe(timer);
    expect(second).toBe(timer);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(getAllEmployeesMock).toHaveBeenCalledTimes(1);

    stopAutomaticBackups();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it('hydrates last backup timestamps from existing files and skips bootstrap daily backup when fresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T09:00:00.000Z'));

    const timer = { kind: 'backup-timer-hydrated' } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);

    readdirSyncMock.mockImplementation((dir: string) => {
      if (dir.includes('daily')) {
        return ['backup-daily-older.json', 'backup-daily-fresh.json'];
      }

      if (dir.includes('weekly')) {
        return ['backup-weekly.json'];
      }

      if (dir.includes('monthly')) {
        return ['backup-monthly.json'];
      }

      return [];
    });

    statSyncMock.mockImplementation((filePath: string) => ({
      mtime: new Date(
        filePath.includes('backup-daily-fresh')
          ? '2026-04-08T08:00:00.000Z'
          : filePath.includes('backup-daily-older')
            ? '2026-04-07T08:00:00.000Z'
            : filePath.includes('backup-weekly')
              ? '2026-04-04T00:00:00.000Z'
              : '2026-03-15T00:00:00.000Z'
      ),
      size: 123
    }));

    readFileSyncMock.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('.json')) {
        if (filePath.includes('backup-daily-fresh')) {
          return JSON.stringify({ metadata: { timestamp: '2026-04-08T08:00:00.000Z' } });
        }

        if (filePath.includes('backup-daily-older')) {
          return JSON.stringify({ metadata: { timestamp: '2026-04-07T08:00:00.000Z' } });
        }

        if (filePath.includes('backup-weekly')) {
          return JSON.stringify({ metadata: { timestamp: '2026-04-04T00:00:00.000Z' } });
        }

        if (filePath.includes('backup-monthly')) {
          return JSON.stringify({ metadata: { timestamp: '2026-03-15T00:00:00.000Z' } });
        }
      }

      return '{}';
    });

    const setupResult = setupAutomaticBackups();

    await Promise.resolve();
    await Promise.resolve();

    expect(setupResult).toBe(timer);
    expect(readFileSyncMock).toHaveBeenCalledWith(expect.stringContaining('backup-daily-fresh.json'), 'utf8');
    expect(readFileSyncMock).toHaveBeenCalledWith(expect.stringContaining('backup-weekly.json'), 'utf8');
    expect(readFileSyncMock).toHaveBeenCalledWith(expect.stringContaining('backup-monthly.json'), 'utf8');
    expect(getAllEmployeesMock).not.toHaveBeenCalled();
  });

  it('creates a bootstrap daily backup when the most recent daily backup is expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T09:00:00.000Z'));

    const timer = { kind: 'backup-timer-expired' } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);

    readdirSyncMock.mockImplementation((dir: string) => {
      if (dir.includes('daily')) {
        return ['backup-daily-expired.json'];
      }

      return [];
    });

    statSyncMock.mockImplementation((filePath: string) => ({
      mtime: new Date(
        filePath.includes('backup-daily-expired')
          ? '2026-04-06T08:00:00.000Z'
          : '2026-03-14T00:00:00.000Z'
      ),
      size: 123
    }));

    readFileSyncMock.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('backup-daily-expired')) {
        return JSON.stringify({ metadata: { timestamp: '2026-04-06T08:00:00.000Z' } });
      }

      return '{}';
    });

    const setupResult = setupAutomaticBackups();

    await Promise.resolve();
    await Promise.resolve();

    expect(setupResult).toBe(timer);
    expect(getAllEmployeesMock).toHaveBeenCalledTimes(1);
  });

  it('allows monitoring and backup schedulers to restart after stop', async () => {
    const monitoringTimer1 = { kind: 'monitor-1' } as unknown as NodeJS.Timeout;
    const monitoringTimer2 = { kind: 'monitor-2' } as unknown as NodeJS.Timeout;
    const backupTimer1 = { kind: 'backup-1' } as unknown as NodeJS.Timeout;
    const backupTimer2 = { kind: 'backup-2' } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValueOnce(monitoringTimer1)
      .mockReturnValueOnce(monitoringTimer2)
      .mockReturnValueOnce(backupTimer1)
      .mockReturnValueOnce(backupTimer2);

    const firstMonitoring = startMonitoring(1000);
    stopMonitoring();
    const secondMonitoring = startMonitoring(1000);

    const firstBackup = setupAutomaticBackups();
    stopAutomaticBackups();
    const secondBackup = setupAutomaticBackups();

    await Promise.resolve();
    await Promise.resolve();

    expect(firstMonitoring).toBe(monitoringTimer1);
    expect(secondMonitoring).toBe(monitoringTimer2);
    expect(firstBackup).toBe(backupTimer1);
    expect(secondBackup).toBe(backupTimer2);
    expect(setIntervalSpy).toHaveBeenCalledTimes(4);
  });

  it('writes backups with restrictive permissions and keeps encrypted backups readable', async () => {
    process.env.ENCRYPTION_KEY = 'backup-encryption-key-123456789012';
    const backupPathContents = new Map<string, string>();
    writeFileMock.mockImplementation(async (filePath: unknown, data: unknown, options?: unknown) => {
      backupPathContents.set(String(filePath), String(data));
      return undefined;
    });

    const backupId = await createDatabaseBackup(BackupType.MANUAL, 'protected backup test');
    const backupPath = [...backupPathContents.keys()][0];
    const storedContent = backupPathContents.get(backupPath);

    expect(storedContent).toBeTruthy();
    expect(writeFileMock).toHaveBeenCalledWith(
      backupPath,
      expect.any(String),
      expect.objectContaining({
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
    );

    const parsedEnvelope = JSON.parse(storedContent || '{}') as { backupProtection?: unknown };
    expect(parsedEnvelope.backupProtection).toBeTruthy();

    readFileSyncMock.mockImplementation((filePath: unknown) => {
      const normalizedPath = String(filePath);
      return backupPathContents.get(normalizedPath) || '{}';
    });

    const inspection = inspectBackupFile(backupId, BackupType.MANUAL);

    expect(inspection.backupId).toBe(backupId);
    expect(inspection.errors).toEqual([]);
  });

  it('lists backups through async filesystem calls and preserves latest-first ordering', async () => {
    readdirMock.mockImplementation(async (dir: string) => {
      if (dir.includes('daily')) {
        return ['backup-daily-old.json', 'notes.txt', 'backup-daily-new.json'];
      }

      return [];
    });

    statMock.mockImplementation(async (filePath: string) => ({
      mtime: new Date(
        filePath.includes('backup-daily-new')
          ? '2026-04-08T08:00:00.000Z'
          : '2026-04-06T08:00:00.000Z'
      ),
      size: filePath.includes('backup-daily-new') ? 222 : 111
    }));

    const backups = await getBackupsList(BackupType.DAILY);

    expect(backups).toHaveLength(2);
    expect(backups.map((backup) => backup.id)).toEqual([
      'backup-daily-new',
      'backup-daily-old'
    ]);
    expect(readdirMock).toHaveBeenCalled();
    expect(statMock).toHaveBeenCalled();
  });

  it('deletes backups through async filesystem calls after validating the backup id', async () => {
    const deleted = await deleteBackup('backup-delete-me', BackupType.MANUAL);

    expect(deleted).toBe(true);
    expect(accessMock).toHaveBeenCalled();
    expect(unlinkMock).toHaveBeenCalledWith(expect.stringContaining('backup-delete-me.json'));
  });
});

describe('db-monitoring restore safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockImplementation(() => true);
    readFileSyncMock.mockReturnValue('{}');
  });

  it('rejects path traversal backup ids before touching the filesystem', () => {
    expect(() => validateBackupId('../outside')).toThrow('Backup id contains invalid path characters');
    expect(() => inspectBackupFile('../../escape', BackupType.MANUAL)).toThrow(
      'Backup id contains invalid path characters'
    );
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('restores inside a transaction using safe delete order and raw table inserts', async () => {
    const backupPayload = {
      metadata: {
        timestamp: '2026-03-14T00:00:00.000Z',
        type: 'manual',
        version: '1.0.0',
        databaseType: 'postgres',
        ...buildAuthorityMetadata()
      },
      employees: [
        {
          id: 7,
          name: 'Alice',
          idNumber: 'aes:encrypted-value',
          isEncrypted: true,
          position: 'Operator',
          department: 'Ops',
          email: null,
          phone: null,
          active: true,
          specialLeaveDays: 0,
          specialLeaveWorkDateRange: null,
          specialLeaveUsedDates: [],
          specialLeaveCashDays: 0,
          specialLeaveCashMonth: null,
          specialLeaveNotes: null,
          createdAt: '2026-03-01T00:00:00.000Z'
        }
      ],
      settings: {
        id: 3,
        baseHourlyRate: 200,
        ot1Multiplier: 1.34,
        ot2Multiplier: 1.67,
        baseMonthSalary: 30000,
        welfareAllowance: 1000,
        deductions: [],
        allowances: [],
        adminPin: 'hashed-pin',
        updatedAt: '2026-03-01T00:00:00.000Z'
      },
      holidays: [
        {
          id: 5,
          employeeId: 7,
          date: '2026/03/10',
          name: '國定假日',
          holidayType: 'national_holiday',
          description: null,
          createdAt: '2026-03-10T00:00:00.000Z'
        }
      ],
      pendingBindings: [
        {
          id: 4,
          employeeId: 7,
          lineUserId: 'line-user-7',
          lineDisplayName: 'Alice Line',
          linePictureUrl: null,
          status: 'approved',
          requestedAt: '2026-03-09T00:00:00.000Z',
          reviewedAt: '2026-03-09T01:00:00.000Z',
          reviewedBy: 'admin',
          rejectReason: null
        }
      ],
      salaryRecords: [
        {
          id: 9,
          salaryYear: 2026,
          salaryMonth: 3,
          employeeId: 7,
          employeeName: 'Alice',
          baseSalary: 30000,
          housingAllowance: 0,
          welfareAllowance: 0,
          totalOT1Hours: 0,
          totalOT2Hours: 0,
          totalOvertimePay: 0,
          holidayDays: 0,
          holidayDailySalary: 0,
          totalHolidayPay: 0,
          grossSalary: 30000,
          deductions: [],
          allowances: [],
          totalDeductions: 0,
          netSalary: 30000,
          attendanceData: [],
          specialLeaveInfo: null,
          createdAt: '2026-03-14T00:00:00.000Z'
        }
      ],
      temporaryAttendance: [
        {
          id: 11,
          employeeId: 7,
          date: '2026/03/14',
          clockIn: '08:00',
          clockOut: '17:00',
          isHoliday: false,
          isBarcodeScanned: true,
          holidayId: 5,
          holidayType: null,
          createdAt: '2026-03-14T00:00:00.000Z'
        }
      ],
      calculationRules: [],
      taiwanHolidays: []
    };

    readFileSyncMock.mockReturnValue(JSON.stringify(backupPayload));
    readFileMock.mockResolvedValue(JSON.stringify(backupPayload));

    const restored = await restoreFromBackup('backup-restore-safe', undefined, {
      skipPreRestoreBackup: true
    });

    expect(restored).toBe(true);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txDeleteMock.mock.calls.map(([table]) => table)).toEqual(
      AUTHORITATIVE_RESTORE_DELETE_ORDER.map((payloadKey) => getSchemaTableForPayloadKey(payloadKey))
    );
    expect(txInsertValuesMock.mock.calls.map(([values]) => values)).toEqual([
      [
        {
          ...backupPayload.employees[0],
          createdAt: new Date(backupPayload.employees[0].createdAt)
        }
      ],
      {
        ...backupPayload.settings,
        updatedAt: new Date(backupPayload.settings.updatedAt)
      },
      [
        {
          ...backupPayload.pendingBindings[0],
          requestedAt: new Date(backupPayload.pendingBindings[0].requestedAt),
          reviewedAt: new Date(backupPayload.pendingBindings[0].reviewedAt)
        }
      ],
      [
        {
          ...backupPayload.holidays[0],
          createdAt: new Date(backupPayload.holidays[0].createdAt)
        }
      ],
      [
        {
          ...backupPayload.salaryRecords[0],
          createdAt: new Date(backupPayload.salaryRecords[0].createdAt)
        }
      ],
      [
        {
          ...backupPayload.temporaryAttendance[0],
          createdAt: new Date(backupPayload.temporaryAttendance[0].createdAt)
        }
      ]
    ]);
    expect(txExecuteMock).toHaveBeenCalledTimes(AUTHORITATIVE_SEQUENCE_TABLES.length);
    expect(createEmployeeMock).not.toHaveBeenCalled();
    expect(createOrUpdateSettingsMock).not.toHaveBeenCalled();
    expect(createHolidayMock).not.toHaveBeenCalled();
    expect(createSalaryRecordMock).not.toHaveBeenCalled();
    expect(createTemporaryAttendanceMock).not.toHaveBeenCalled();
  });

  it('rejects backups that violate employee foreign-key readiness checks', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        metadata: {
          timestamp: '2026-03-14T00:00:00.000Z',
          type: 'manual',
          version: '1.0.0',
          databaseType: 'postgres',
          ...buildAuthorityMetadata()
        },
        employees: [],
        settings: null,
        holidays: [
          {
            id: 1,
            employeeId: 999,
            date: '2026/03/14',
            name: '國定假日',
            holidayType: 'national_holiday',
            description: null,
            createdAt: '2026-03-14T00:00:00.000Z'
          }
        ],
        pendingBindings: [],
        salaryRecords: [],
        temporaryAttendance: [],
        calculationRules: [],
        taiwanHolidays: []
      })
    );
    readFileMock.mockResolvedValue(readFileSyncMock());

    await expect(
      restoreFromBackup('backup-invalid-fk', undefined, {
        skipPreRestoreBackup: true
      })
    ).rejects.toThrow(/Restore failed/);

    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects backups that contain orphan references inside nested salary attendance snapshots', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        metadata: {
          timestamp: '2026-03-14T00:00:00.000Z',
          type: 'manual',
          version: '1.0.0',
          databaseType: 'postgres',
          ...buildAuthorityMetadata()
        },
        employees: [
          {
            id: 7,
            name: 'Alice',
            idNumber: 'A123456789',
            isEncrypted: false,
            position: 'Operator',
            department: 'Ops',
            email: null,
            phone: null,
            active: true,
            specialLeaveDays: 0,
            specialLeaveWorkDateRange: null,
            specialLeaveUsedDates: [],
            specialLeaveCashDays: 0,
            specialLeaveCashMonth: null,
            specialLeaveNotes: null,
            createdAt: '2026-03-01T00:00:00.000Z'
          }
        ],
        settings: null,
        holidays: [
          {
            id: 5,
            employeeId: 7,
            date: '2026/03/10',
            name: '???',
            holidayType: 'national_holiday',
            description: null,
            createdAt: '2026-03-10T00:00:00.000Z'
          }
        ],
        pendingBindings: [],
        salaryRecords: [
          {
            id: 9,
            salaryYear: 2026,
            salaryMonth: 3,
            employeeId: 7,
            employeeName: 'Alice',
            baseSalary: 30000,
            housingAllowance: 0,
            welfareAllowance: 0,
            totalOT1Hours: 0,
            totalOT2Hours: 0,
            totalOvertimePay: 0,
            holidayDays: 0,
            holidayDailySalary: 0,
            totalHolidayPay: 0,
            grossSalary: 30000,
            deductions: [],
            allowances: [],
            totalDeductions: 0,
            netSalary: 30000,
            attendanceData: [
              {
                id: 11,
                employeeId: 999,
                date: '2026/03/14',
                clockIn: '08:00',
                clockOut: '17:00',
                isHoliday: false,
                isBarcodeScanned: true,
                holidayId: 5,
                holidayType: null,
                createdAt: '2026-03-14T00:00:00.000Z'
              }
            ],
            specialLeaveInfo: null,
            createdAt: '2026-03-14T00:00:00.000Z'
          }
        ],
        temporaryAttendance: [],
        calculationRules: [],
        taiwanHolidays: []
      })
    );

    const inspection = inspectBackupFileAtPath('/tmp/backups/manual/backup-nested-orphan.json', {
      backupId: 'backup-nested-orphan',
      backupType: 'manual'
    });

    expect(inspection.errors.length).toBeGreaterThan(0);

    await expect(
      restoreFromBackup('backup-nested-orphan', undefined, {
        skipPreRestoreBackup: true
      })
    ).rejects.toThrow();

    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects backups that keep deleted employee lifecycle artifacts and deleted-employee pending bindings', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        metadata: {
          timestamp: '2026-03-14T00:00:00.000Z',
          type: 'manual',
          version: '1.0.0',
          databaseType: 'postgres',
          ...buildAuthorityMetadata()
        },
        employees: [
          {
            id: 7,
            name: 'Deleted Employee',
            idNumber: 'A123456789',
            isEncrypted: false,
            position: 'Operator',
            department: 'Ops',
            email: null,
            phone: null,
            active: false,
            lineUserId: 'line-user-7',
            lineDisplayName: 'Deleted User',
            linePictureUrl: null,
            lineBindingDate: '2026-03-01T00:00:00.000Z',
            specialLeaveDays: 0,
            specialLeaveWorkDateRange: null,
            specialLeaveUsedDates: [],
            specialLeaveCashDays: 0,
            specialLeaveCashMonth: null,
            specialLeaveNotes: null,
            deletedAt: '2026-03-12T00:00:00.000Z',
            deletedBy: 'retention-test',
            purgeAfterAt: '2026-03-10T00:00:00.000Z',
            createdAt: '2026-03-01T00:00:00.000Z'
          }
        ],
        settings: null,
        holidays: [],
        pendingBindings: [
          {
            id: 4,
            employeeId: 7,
            lineUserId: 'pending-line-7',
            lineDisplayName: 'Pending Deleted User',
            linePictureUrl: null,
            status: 'pending',
            requestedAt: '2026-03-12T01:00:00.000Z',
            reviewedAt: null,
            reviewedBy: null,
            rejectReason: null
          }
        ],
        salaryRecords: [],
        temporaryAttendance: [],
        calculationRules: [],
        taiwanHolidays: []
      })
    );

    const inspection = inspectBackupFileAtPath('/tmp/backups/manual/backup-invalid-deleted-lifecycle.json', {
      backupId: 'backup-invalid-deleted-lifecycle',
      backupType: 'manual'
    });

    expect(inspection.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('employee #7 has purgeAfterAt that is not later than deletedAt'),
        expect.stringContaining('employee #7 is deleted but still carries LINE binding data'),
        expect.stringContaining('pending binding #4 references deleted employee #7')
      ])
    );
    readFileMock.mockResolvedValue(readFileSyncMock());

    await expect(
      restoreFromBackup('backup-invalid-deleted-lifecycle', undefined, {
        skipPreRestoreBackup: true
      })
    ).rejects.toThrow(/Restore failed/);

    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('rejects backups with incomplete anonymized salary retention metadata', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        metadata: {
          timestamp: '2026-03-14T00:00:00.000Z',
          type: 'manual',
          version: '1.0.0',
          databaseType: 'postgres',
          ...buildAuthorityMetadata()
        },
        employees: [],
        settings: null,
        holidays: [],
        pendingBindings: [],
        salaryRecords: [
          {
            id: 9,
            salaryYear: 2026,
            salaryMonth: 3,
            employeeId: null,
            employeeName: '[ANONYMIZED EMPLOYEE - RETAIN 5 YEARS]',
            baseSalary: 30000,
            housingAllowance: 0,
            welfareAllowance: 0,
            totalOT1Hours: 0,
            totalOT2Hours: 0,
            totalOvertimePay: 0,
            holidayDays: 0,
            holidayDailySalary: 0,
            totalHolidayPay: 0,
            grossSalary: 30000,
            deductions: [],
            allowances: [],
            totalDeductions: 0,
            netSalary: 30000,
            attendanceData: [
              {
                id: 11,
                employeeId: 77,
                date: '2026/03/14',
                clockIn: '08:00',
                clockOut: '17:00',
                isHoliday: false,
                isBarcodeScanned: false,
                holidayId: null,
                holidayType: null,
                createdAt: '2026-03-14T00:00:00.000Z'
              }
            ],
            specialLeaveInfo: null,
            anonymizedAt: null,
            retentionUntil: '2026-03-14T00:00:00.000Z',
            employeeSnapshot: {
              employeeType: 'foreign',
              department: 'Ops',
              position: 'Operator',
              deletedAt: null,
              deletedBy: 'retention-test',
              retentionYears: 1,
              retentionPolicy: 'wrong_policy'
            },
            createdAt: '2026-03-14T00:00:00.000Z'
          }
        ],
        temporaryAttendance: [],
        calculationRules: [],
        taiwanHolidays: []
      })
    );

    const inspection = inspectBackupFileAtPath('/tmp/backups/manual/backup-invalid-anonymized-salary.json', {
      backupId: 'backup-invalid-anonymized-salary',
      backupType: 'manual'
    });

    expect(inspection.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('salary record #9 is anonymized but missing anonymizedAt'),
        expect.stringContaining('salary record #9 is anonymized but employeeSnapshot.deletedAt is missing'),
        expect.stringContaining('salary record #9 is anonymized but employeeSnapshot.retentionYears is not 5'),
        expect.stringContaining(
          'salary record #9 is anonymized but employeeSnapshot.retentionPolicy is not salary_record_anonymized_retained_5_years'
        ),
        expect.stringContaining('salary record #9 is anonymized but attendanceData still contains employeeId values')
      ])
    );
    readFileMock.mockResolvedValue(readFileSyncMock());

    await expect(
      restoreFromBackup('backup-invalid-anonymized-salary', undefined, {
        skipPreRestoreBackup: true
      })
    ).rejects.toThrow(/Restore failed/);

    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('inspects legacy manual backup paths and surfaces authority drift errors', () => {
    readFileSyncMock.mockReturnValue('{}');

    const inspection = inspectBackupFileAtPath('/tmp/backups/manual/backup-legacy.json', {
      backupId: 'backup-legacy',
      backupType: 'manual'
    });

    expect(inspection.backupId).toBe('backup-legacy');
    expect(inspection.path).toBe('/tmp/backups/manual/backup-legacy.json');
    expect(
      inspection.errors.some((message) => message.includes('Backup payload is missing authoritative tables'))
    ).toBe(true);
    expect(inspection.warnings).toContain('Backup metadata missing timestamp');
  });

  it('rehearses restore inside a transaction and rolls back after collecting restored counts', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        metadata: {
          timestamp: '2026-03-15T00:00:00.000Z',
          type: 'manual',
          version: '1.0.0',
          databaseType: 'postgres',
          ...buildAuthorityMetadata()
        },
        employees: [
          {
            id: 3,
            name: 'Rehearsal Employee',
            idNumber: 'A123456789',
            isEncrypted: false,
            position: 'Tester',
            department: 'QA',
            email: null,
            phone: null,
            active: true,
            specialLeaveDays: 0,
            specialLeaveWorkDateRange: null,
            specialLeaveUsedDates: [],
            specialLeaveCashDays: 0,
            specialLeaveCashMonth: null,
            specialLeaveNotes: null,
            createdAt: '2026-03-15T00:00:00.000Z'
          }
        ],
        settings: null,
        pendingBindings: [],
        holidays: [],
        salaryRecords: [],
        temporaryAttendance: [],
        calculationRules: [],
        taiwanHolidays: []
      })
    );
    readFileMock.mockResolvedValue(readFileSyncMock());

    executeMock
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 4 }])
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([{ count: 10 }]);

    txExecuteMock
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0 }]);

    const result = await rehearseRestoreFromBackup('backup-rehearsal-safe');

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(result.rehearsalRolledBack).toBe(true);
    expect(result.backupCounts).toEqual({
      employees: 1,
      hasSettings: false,
      pendingBindings: 0,
      holidays: 0,
      salaryRecords: 0,
      temporaryAttendance: 0,
      calculationRules: 0,
      taiwanHolidays: 0
    });
    expect(result.liveCountsBefore).toEqual({
      employees: 2,
      hasSettings: true,
      pendingBindings: 1,
      holidays: 1,
      salaryRecords: 4,
      temporaryAttendance: 3,
      calculationRules: 2,
      taiwanHolidays: 10
    });
    expect(result.restoredCountsInTransaction).toEqual({
      employees: 1,
      hasSettings: false,
      pendingBindings: 0,
      holidays: 0,
      salaryRecords: 0,
      temporaryAttendance: 0,
      calculationRules: 0,
      taiwanHolidays: 0
    });
    expect(result.warnings).toContain(
      'Restore rehearsal skips sequence reset because PostgreSQL sequences are not transactional.'
    );
  });

  it('retries restore transactions when PostgreSQL reports a deadlock', async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        metadata: {
          timestamp: '2026-03-16T00:00:00.000Z',
          type: 'manual',
          version: '1.0.0',
          databaseType: 'postgres',
          ...buildAuthorityMetadata()
        },
        employees: [],
        settings: null,
        pendingBindings: [],
        holidays: [],
        salaryRecords: [],
        temporaryAttendance: [],
        calculationRules: [],
        taiwanHolidays: []
      })
    );
    readFileMock.mockResolvedValue(readFileSyncMock());

    const deadlockError = Object.assign(new Error('deadlock detected'), {
      cause: { code: '40P01' }
    });

    transactionMock
      .mockRejectedValueOnce(deadlockError)
      .mockImplementationOnce(async (callback) =>
        callback({
          delete: txDeleteMock,
          insert: txInsertMock,
          execute: txExecuteMock
        })
      );

    const restored = await restoreFromBackup('backup-restore-retry', undefined, {
      skipPreRestoreBackup: true
    });

    expect(restored).toBe(true);
    expect(transactionMock).toHaveBeenCalledTimes(2);
  });
});
