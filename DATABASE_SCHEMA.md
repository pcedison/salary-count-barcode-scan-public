# Database Schema

Current Drizzle-managed schema for `barcode_scan_V3`.

## Overview
- Primary database: PostgreSQL.
- Schema source of truth: `shared/schema.ts`.
- Drizzle manages the application tables below.
- Session storage also uses a runtime table created by `connect-pg-simple`, but that table is not part of the Drizzle contract.

## Active Tables

### `employees`
Employee master data and lifecycle metadata.

| Column | Notes |
| --- | --- |
| `id` | Serial primary key. |
| `name` | Employee display name. |
| `id_number` | Unique employee identifier used for barcode / scan lookup. |
| `is_encrypted` | Marks encrypted identity storage. |
| `position`, `department`, `email`, `phone` | Profile fields. |
| `active` | Soft activation flag. |
| `employee_type` | `local` or `foreign`. |
| `line_user_id`, `line_display_name`, `line_picture_url`, `line_binding_date` | LINE binding metadata. |
| `special_leave_days`, `special_leave_work_date_range`, `special_leave_used_dates`, `special_leave_cash_days`, `special_leave_cash_month`, `special_leave_notes` | Special leave tracking. |
| `deleted_at`, `deleted_by`, `purge_after_at` | Recycle-bin and purge lifecycle fields. |
| `created_at` | Creation timestamp. |

Indexes and constraints:
- Unique constraint on `id_number`.
- Index `employees_id_number_idx` on `id_number`.

### `temporary_attendance`
Temporary attendance records used by the attendance and scan flow.

| Column | Notes |
| --- | --- |
| `id` | Serial primary key. |
| `employee_id` | Nullable employee reference. |
| `date` | Stored as text in app date format. |
| `clock_in`, `clock_out` | Clock times. |
| `is_holiday` | Holiday flag. |
| `is_barcode_scanned` | Whether the row came from barcode scanning. |
| `holiday_id` | Optional holiday reference. |
| `holiday_type` | App-managed type string such as `worked`, `sick_leave`, `personal_leave`, `national_holiday`, `typhoon_leave`, `special_leave`. |
| `created_at` | Creation timestamp. |

Indexes:
- `ta_employee_id_idx` on `employee_id`.
- `ta_date_idx` on `date`.

### `settings`
Application settings and payroll defaults.

| Column | Notes |
| --- | --- |
| `id` | Serial primary key. |
| `base_hourly_rate` | Default hourly rate. |
| `ot1_multiplier`, `ot2_multiplier` | Overtime multipliers. |
| `base_month_salary` | Base monthly salary. |
| `welfare_allowance` | Welfare allowance. |
| `deductions` | JSON list of deduction items. |
| `allowances` | JSON list of allowance items. |
| `admin_pin` | Stored admin PIN hash. Never expose this through the public settings payload. |
| `barcode_enabled` | Master switch for scan endpoints. |
| `updated_at` | Last update timestamp. |

Operational note:
- `GET /api/settings` returns a public payload only.
- `GET /api/settings/admin` includes deductions and allowances.

### `salary_records`
Finalized salary results.

| Column | Notes |
| --- | --- |
| `id` | Serial primary key. |
| `salary_year`, `salary_month` | Salary period. |
| `employee_id` | Nullable employee reference. |
| `employee_name` | Snapshot of employee name at calculation time. |
| `base_salary`, `housing_allowance`, `welfare_allowance` | Pay components. |
| `total_ot1_hours`, `total_ot2_hours`, `total_overtime_pay` | Overtime totals. |
| `holiday_days`, `holiday_daily_salary`, `total_holiday_pay` | Holiday pay fields. |
| `gross_salary`, `net_salary` | Final payroll totals. |
| `deductions`, `allowances` | JSON detail lists. |
| `total_deductions` | Aggregate deduction total. |
| `attendance_data` | Attendance snapshot used for the calculation. |
| `special_leave_info` | Special leave calculation snapshot. |
| `anonymized_at`, `retention_until` | Retention and anonymization lifecycle fields. |
| `employee_snapshot` | Employee metadata snapshot for retention / purge behavior. |
| `created_at` | Creation timestamp. |

Indexes and constraints:
- `sr_year_month_employee_idx` on `(salary_year, salary_month, employee_id)`.
- Unique constraint `salary_records_year_month_emp_idx` on `(salary_year, salary_month, employee_id)`.

### `holidays`
Custom holiday and leave records.

| Column | Notes |
| --- | --- |
| `id` | Serial primary key. |
| `employee_id` | Optional employee reference. |
| `date` | Holiday date stored as text. |
| `name` | Holiday or leave label. |
| `holiday_type` | Enum: `national_holiday`, `special_leave`, `sick_leave`, `personal_leave`, `typhoon_leave`, `worked`. |
| `description` | Optional description. |
| `created_at` | Creation timestamp. |

Indexes:
- `holidays_employee_id_idx` on `employee_id`.
- `holidays_date_idx` on `date`.

### `pending_bindings`
LINE binding requests awaiting admin review.

| Column | Notes |
| --- | --- |
| `id` | Serial primary key. |
| `employee_id` | Employee requested for binding. |
| `line_user_id` | LINE user id. |
| `line_display_name`, `line_picture_url` | Display metadata. |
| `status` | Workflow status managed by the app. |
| `requested_at`, `reviewed_at` | Workflow timestamps. |
| `reviewed_by` | Reviewer identity. |
| `reject_reason` | Rejection reason. |

Index:
- `pb_line_user_id_idx` on `line_user_id`.

### `oauth_states`
Transient OAuth state table used by LINE login.

| Column | Notes |
| --- | --- |
| `id` | Serial primary key. |
| `state` | Unique OAuth state token. |
| `created_at` | Creation timestamp. |
| `expires_at` | Expiration timestamp. |

### `calculation_rules`
Versioned payroll calculation rules.

| Column | Notes |
| --- | --- |
| `id` | Serial primary key. |
| `rule_key` | Unique stable key for the rule. |
| `version` | Rule version string. |
| `year`, `month`, `employee_id` | Scope fields. |
| `total_ot1_hours`, `total_ot2_hours` | Source overtime hours. |
| `base_salary`, `welfare_allowance`, `housing_allowance` | Base inputs. |
| `total_overtime_pay`, `gross_salary`, `net_salary` | Calculated outputs. |
| `description`, `created_by` | Audit metadata. |
| `created_at`, `updated_at` | Timestamps. |
| `is_active` | Active flag. |

### `taiwan_holidays`
Imported Taiwan public holidays.

| Column | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `year` | Holiday year. |
| `holiday_date` | Date string. |
| `holiday_name` | Holiday name. |
| `is_holiday` | Holiday flag. |
| `created_at` | Creation timestamp. |

Constraint:
- Unique constraint on `(year, holiday_date)`.

## Runtime Tables Not Managed By Drizzle
- `user_sessions`: created by `connect-pg-simple` for Express sessions.
- This table is part of runtime infrastructure, not the Drizzle schema contract.

## Index And Constraint Summary
- `employees.id_number` is unique.
- `temporary_attendance` supports employee/date lookups.
- `salary_records` supports year/month/employee lookups and enforces one record per employee per month.
- `holidays` supports employee and date lookups.
- `pending_bindings` supports LINE user lookup.
- `oauth_states.state` is unique.
- `calculation_rules.rule_key` is unique.
- `taiwan_holidays` is unique per `(year, holiday_date)`.

## Legacy / Archived Names
These names appear in older documentation but are not the current runtime contract:
- `attendance_records`
- `system_settings`
- `session`

If you are integrating with the current codebase, use the tables listed in the Active Tables section above.
