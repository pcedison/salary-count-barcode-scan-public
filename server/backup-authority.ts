export type AuthoritativeBackupPayloadKey =
  | 'employees'
  | 'settings'
  | 'pendingBindings'
  | 'holidays'
  | 'salaryRecords'
  | 'temporaryAttendance'
  | 'calculationRules'
  | 'taiwanHolidays';

export type DatabaseCountKey =
  | 'employees'
  | 'hasSettings'
  | 'pendingBindings'
  | 'holidays'
  | 'salaryRecords'
  | 'temporaryAttendance'
  | 'calculationRules'
  | 'taiwanHolidays';

type IncludedAuthorityTable = {
  payloadKey: AuthoritativeBackupPayloadKey;
  tableName: string;
  countKey: DatabaseCountKey;
  countMode: 'rows' | 'presence';
  restoreDeleteOrder: number;
  restoreInsertOrder: number;
  resetSequence: boolean;
  notes: string;
};

type ExcludedAuthorityTable = {
  tableName: string;
  reason: string;
};

export const BACKUP_AUTHORITY_VERSION = 2;

export const AUTHORITATIVE_BACKUP_TABLES: readonly IncludedAuthorityTable[] = [
  {
    payloadKey: 'employees',
    tableName: 'employees',
    countKey: 'employees',
    countMode: 'rows',
    restoreDeleteOrder: 30,
    restoreInsertOrder: 10,
    resetSequence: true,
    notes: 'Includes recycle-bin rows via getAllEmployeesIncludingDeleted().'
  },
  {
    payloadKey: 'settings',
    tableName: 'settings',
    countKey: 'hasSettings',
    countMode: 'presence',
    restoreDeleteOrder: 40,
    restoreInsertOrder: 20,
    resetSequence: true,
    notes: 'Singleton settings row; compare by presence to avoid implying multi-row support.'
  },
  {
    payloadKey: 'pendingBindings',
    tableName: 'pending_bindings',
    countKey: 'pendingBindings',
    countMode: 'rows',
    restoreDeleteOrder: 60,
    restoreInsertOrder: 50,
    resetSequence: true,
    notes: 'Authority coverage includes pending/approved binding records that survive employee lifecycle events.'
  },
  {
    payloadKey: 'holidays',
    tableName: 'holidays',
    countKey: 'holidays',
    countMode: 'rows',
    restoreDeleteOrder: 50,
    restoreInsertOrder: 60,
    resetSequence: true,
    notes: 'Holiday records include employee-linked leave rows and must restore before attendance.'
  },
  {
    payloadKey: 'salaryRecords',
    tableName: 'salary_records',
    countKey: 'salaryRecords',
    countMode: 'rows',
    restoreDeleteOrder: 70,
    restoreInsertOrder: 70,
    resetSequence: true,
    notes: 'Salary records carry retention/anonymization state and employee snapshots.'
  },
  {
    payloadKey: 'temporaryAttendance',
    tableName: 'temporary_attendance',
    countKey: 'temporaryAttendance',
    countMode: 'rows',
    restoreDeleteOrder: 80,
    restoreInsertOrder: 80,
    resetSequence: true,
    notes: 'Attendance must restore after holidays to preserve holiday-linked rows.'
  },
  {
    payloadKey: 'calculationRules',
    tableName: 'calculation_rules',
    countKey: 'calculationRules',
    countMode: 'rows',
    restoreDeleteOrder: 10,
    restoreInsertOrder: 40,
    resetSequence: true,
    notes: 'Active payroll rules are runtime authority and must not drift across restore.'
  },
  {
    payloadKey: 'taiwanHolidays',
    tableName: 'taiwan_holidays',
    countKey: 'taiwanHolidays',
    countMode: 'rows',
    restoreDeleteOrder: 20,
    restoreInsertOrder: 30,
    resetSequence: false,
    notes: 'Reference holiday dataset is treated as authoritative restore state to avoid environment drift.'
  }
] as const;

export const EXCLUDED_BACKUP_TABLES: readonly ExcludedAuthorityTable[] = [
  {
    tableName: 'oauth_states',
    reason: 'Ephemeral LINE OAuth state. Safe to discard and regenerate on next login.'
  },
  {
    tableName: 'user_sessions',
    reason: 'Ephemeral session store. Restores should force fresh authentication, not replay old sessions.'
  }
] as const;

export const AUTHORITATIVE_BACKUP_PAYLOAD_KEYS = AUTHORITATIVE_BACKUP_TABLES.map(
  (table) => table.payloadKey
) as readonly AuthoritativeBackupPayloadKey[];

export const AUTHORITATIVE_TABLE_NAMES = AUTHORITATIVE_BACKUP_TABLES.map(
  (table) => table.tableName
);

export const EXCLUDED_TABLE_NAMES = EXCLUDED_BACKUP_TABLES.map((table) => table.tableName);

export const AUTHORITATIVE_RESTORE_DELETE_ORDER = [...AUTHORITATIVE_BACKUP_TABLES]
  .sort((left, right) => right.restoreDeleteOrder - left.restoreDeleteOrder)
  .map((table) => table.payloadKey);

export const AUTHORITATIVE_RESTORE_INSERT_ORDER = [...AUTHORITATIVE_BACKUP_TABLES]
  .sort((left, right) => left.restoreInsertOrder - right.restoreInsertOrder)
  .map((table) => table.payloadKey);

export const AUTHORITATIVE_SEQUENCE_TABLES = AUTHORITATIVE_BACKUP_TABLES.filter(
  (table) => table.resetSequence
).map((table) => table.tableName);
