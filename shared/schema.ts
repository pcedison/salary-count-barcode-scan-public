import { pgTable, text, serial, integer, boolean, timestamp, json, doublePrecision, varchar, unique, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Employee master data for barcode scanning and LINE binding.
export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  idNumber: text("id_number").notNull().unique(),
  isEncrypted: boolean("is_encrypted").default(false),
  position: text("position"),
  department: text("department"),
  email: text("email"),
  phone: text("phone"),
  active: boolean("active").default(true),
  employeeType: text("employee_type", { enum: ["local", "foreign"] }).default('local'),
  lineUserId: text("line_user_id"),
  lineDisplayName: text("line_display_name"),
  linePictureUrl: text("line_picture_url"),
  lineBindingDate: timestamp("line_binding_date", { withTimezone: true }),
  specialLeaveDays: integer("special_leave_days").default(0),
  specialLeaveWorkDateRange: text("special_leave_work_date_range"),
  specialLeaveUsedDates: json("special_leave_used_dates").$type<string[]>().default([]),
  specialLeaveCashDays: integer("special_leave_cash_days").default(0),
  specialLeaveCashMonth: text("special_leave_cash_month"),
  specialLeaveNotes: text("special_leave_notes"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by"),
  purgeAfterAt: timestamp("purge_after_at", { withTimezone: true }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  idNumberIdx: index("employees_id_number_idx").on(table.idNumber),
}));

export const insertEmployeeSchema = createInsertSchema(employees)
  .omit({
    id: true,
    deletedAt: true,
    deletedBy: true,
    purgeAfterAt: true,
    createdAt: true
  });

export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employees.$inferSelect;

// Temporary attendance records.
export const temporaryAttendance = pgTable("temporary_attendance", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id"),
  date: text("date").notNull(),
  clockIn: text("clock_in").notNull(),
  clockOut: text("clock_out").default(''),
  isHoliday: boolean("is_holiday").default(false),
  isBarcodeScanned: boolean("is_barcode_scanned").default(false),
  holidayId: integer("holiday_id"),
  holidayType: text("holiday_type"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  employeeIdIdx: index("ta_employee_id_idx").on(table.employeeId),
  dateIdx: index("ta_date_idx").on(table.date),
}));

export const insertTemporaryAttendanceSchema = createInsertSchema(temporaryAttendance)
  .omit({ id: true, createdAt: true });

export type InsertTemporaryAttendance = z.infer<typeof insertTemporaryAttendanceSchema>;
export type TemporaryAttendance = typeof temporaryAttendance.$inferSelect;

// Salary settings.
export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  baseHourlyRate: doublePrecision("base_hourly_rate").notNull().default(119),
  ot1Multiplier: doublePrecision("ot1_multiplier").notNull().default(1.34),
  ot2Multiplier: doublePrecision("ot2_multiplier").notNull().default(1.67),
  baseMonthSalary: doublePrecision("base_month_salary").notNull().default(28590),
  welfareAllowance: doublePrecision("welfare_allowance").notNull().default(0),
  deductions: json("deductions").$type<{ name: string; amount: number; description: string }[]>().default([]),
  allowances: json("allowances").$type<{ name: string; amount: number; description: string }[]>().default([]),
  adminPin: text("admin_pin").notNull(),
  barcodeEnabled: boolean("barcode_enabled").default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSettingsSchema = createInsertSchema(settings)
  .omit({ id: true, updatedAt: true });

export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settings.$inferSelect;

// Finalized salary records.
export const salaryRecords = pgTable("salary_records", {
  id: serial("id").primaryKey(),
  salaryYear: integer("salary_year").notNull(),
  salaryMonth: integer("salary_month").notNull(),
  employeeId: integer("employee_id"),
  employeeName: text("employee_name"),
  baseSalary: doublePrecision("base_salary").notNull(),
  housingAllowance: doublePrecision("housing_allowance").default(0),
  welfareAllowance: doublePrecision("welfare_allowance").default(0),
  totalOT1Hours: doublePrecision("total_ot1_hours").default(0),
  totalOT2Hours: doublePrecision("total_ot2_hours").default(0),
  totalOvertimePay: doublePrecision("total_overtime_pay").default(0),
  holidayDays: integer("holiday_days").default(0),
  holidayDailySalary: doublePrecision("holiday_daily_salary").default(0),
  totalHolidayPay: doublePrecision("total_holiday_pay").default(0),
  grossSalary: doublePrecision("gross_salary").notNull(),
  deductions: json("deductions").$type<{ name: string; amount: number }[]>().default([]),
  allowances: json("allowances").$type<{ name: string; amount: number; description?: string }[]>().default([]),
  totalDeductions: doublePrecision("total_deductions").default(0),
  netSalary: doublePrecision("net_salary").notNull(),
  attendanceData: json("attendance_data").$type<TemporaryAttendance[]>(),
  specialLeaveInfo: json("special_leave_info").$type<{
    usedDays: number;
    usedDates: string[];
    cashDays: number;
    cashAmount: number;
    notes?: string;
  }>(),
  anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
  retentionUntil: timestamp("retention_until", { withTimezone: true }),
  employeeSnapshot: json("employee_snapshot").$type<{
    employeeType: "local" | "foreign" | null;
    department: string | null;
    position: string | null;
    deletedAt: string | null;
    deletedBy: string | null;
    retentionYears?: number;
    retentionPolicy?: string;
  }>(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  yearMonthEmployeeIdx: index("sr_year_month_employee_idx").on(table.salaryYear, table.salaryMonth, table.employeeId),
  salaryYearMonthEmpUniq: unique("salary_records_year_month_emp_idx").on(table.salaryYear, table.salaryMonth, table.employeeId),
}));

export const insertSalaryRecordSchema = createInsertSchema(salaryRecords)
  .omit({
    id: true,
    anonymizedAt: true,
    retentionUntil: true,
    employeeSnapshot: true,
    createdAt: true
  });

export type InsertSalaryRecord = z.infer<typeof insertSalaryRecordSchema>;
export type SalaryRecord = typeof salaryRecords.$inferSelect;

// Holiday settings.
export const holidays = pgTable("holidays", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").references(() => employees.id),
  date: text("date").notNull(),
  name: text("name").notNull(),
  holidayType: text("holiday_type", {
    enum: ["worked", "sick_leave", "personal_leave", "national_holiday", "typhoon_leave", "special_leave"]
  }).notNull().default("national_holiday"),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  employeeIdIdx: index("holidays_employee_id_idx").on(table.employeeId),
  dateIdx: index("holidays_date_idx").on(table.date),
}));

export const insertHolidaySchema = createInsertSchema(holidays)
  .omit({ id: true, createdAt: true });

export const holidayTypeOptions = [
  { value: "national_holiday", label: "國定假日", paid: true, deductPay: false, description: "帶薪，不扣薪" },
  { value: "special_leave", label: "特別休假", paid: true, deductPay: false, description: "帶薪特休" },
  { value: "sick_leave", label: "病假", paid: false, deductPay: true, description: "病假扣薪" },
  { value: "personal_leave", label: "事假", paid: false, deductPay: true, description: "事假扣薪" },
  { value: "typhoon_leave", label: "颱風假", paid: false, deductPay: true, description: "依公司規定處理" },
  { value: "worked", label: "假日出勤", paid: true, deductPay: false, description: "假日出勤加給" }
] as const;

export type InsertHoliday = z.infer<typeof insertHolidaySchema>;
export type Holiday = typeof holidays.$inferSelect;

// LINE binding workflow.
export const pendingBindings = pgTable("pending_bindings", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
  lineUserId: text("line_user_id").notNull(),
  lineDisplayName: text("line_display_name"),
  linePictureUrl: text("line_picture_url"),
  status: text("status").notNull(),
  requestedAt: timestamp("requested_at"),
  reviewedAt: timestamp("reviewed_at"),
  reviewedBy: text("reviewed_by"),
  rejectReason: text("reject_reason"),
}, (table) => ({
  lineUserIdIdx: index("pb_line_user_id_idx").on(table.lineUserId),
}));

export const insertPendingBindingSchema = createInsertSchema(pendingBindings)
  .omit({ id: true });

export type InsertPendingBinding = z.infer<typeof insertPendingBindingSchema>;
export type PendingBinding = typeof pendingBindings.$inferSelect;

// OAuth state storage for LINE login.
export const oauthStates = pgTable("oauth_states", {
  id: serial("id").primaryKey(),
  state: text("state").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const insertOAuthStateSchema = createInsertSchema(oauthStates)
  .omit({ id: true, createdAt: true });

export type InsertOAuthState = z.infer<typeof insertOAuthStateSchema>;
export type OAuthState = typeof oauthStates.$inferSelect;

// Calculation rule snapshots.
export const calculationRules = pgTable("calculation_rules", {
  id: serial("id").primaryKey(),
  ruleKey: varchar("rule_key", { length: 50 }).notNull().unique(),
  version: varchar("version", { length: 20 }).notNull(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  employeeId: integer("employee_id"),
  totalOT1Hours: doublePrecision("total_ot1_hours").notNull(),
  totalOT2Hours: doublePrecision("total_ot2_hours").notNull(),
  baseSalary: doublePrecision("base_salary").notNull(),
  welfareAllowance: doublePrecision("welfare_allowance"),
  housingAllowance: doublePrecision("housing_allowance"),
  totalOvertimePay: doublePrecision("total_overtime_pay").notNull(),
  grossSalary: doublePrecision("gross_salary").notNull(),
  netSalary: doublePrecision("net_salary").notNull(),
  description: text("description"),
  createdBy: varchar("created_by", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  isActive: boolean("is_active").default(true),
});

export const insertCalculationRuleSchema = createInsertSchema(calculationRules)
  .omit({ id: true, createdAt: true, updatedAt: true });

export type InsertCalculationRule = z.infer<typeof insertCalculationRuleSchema>;
export type CalculationRule = typeof calculationRules.$inferSelect;

// Taiwan holiday reference table.
export const taiwanHolidays = pgTable("taiwan_holidays", {
  id: uuid("id").primaryKey().default(sql`uuid_generate_v4()`),
  year: integer("year").notNull(),
  holidayDate: text("holiday_date").notNull(),
  holidayName: text("holiday_name").notNull(),
  isHoliday: boolean("is_holiday").default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  uniqueYearDate: unique().on(table.year, table.holidayDate),
}));

export const insertTaiwanHolidaySchema = createInsertSchema(taiwanHolidays)
  .omit({ id: true, createdAt: true });

export type InsertTaiwanHoliday = z.infer<typeof insertTaiwanHolidaySchema>;
export type TaiwanHoliday = typeof taiwanHolidays.$inferSelect;
