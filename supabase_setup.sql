-- Create temporary_attendance table
CREATE TABLE IF NOT EXISTS temporary_attendance (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  clock_in TEXT NOT NULL,
  clock_out TEXT NOT NULL,
  is_holiday BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create settings table
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  base_hourly_rate NUMERIC NOT NULL DEFAULT 119,
  ot1_multiplier NUMERIC NOT NULL DEFAULT 1.34,
  ot2_multiplier NUMERIC NOT NULL DEFAULT 1.67,
  base_month_salary NUMERIC NOT NULL DEFAULT 28590,
  deductions JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create salary_records table
CREATE TABLE IF NOT EXISTS salary_records (
  id SERIAL PRIMARY KEY,
  salary_year INTEGER NOT NULL,
  salary_month INTEGER NOT NULL,
  base_salary NUMERIC NOT NULL,
  housing_allowance NUMERIC DEFAULT 0,
  total_ot1_hours NUMERIC NOT NULL DEFAULT 0,
  total_ot2_hours NUMERIC NOT NULL DEFAULT 0,
  total_overtime_pay NUMERIC NOT NULL DEFAULT 0,
  holiday_days INTEGER NOT NULL DEFAULT 0,
  holiday_daily_salary NUMERIC NOT NULL DEFAULT 0,
  total_holiday_pay NUMERIC NOT NULL DEFAULT 0,
  gross_salary NUMERIC NOT NULL,
  deductions JSONB DEFAULT '[]'::jsonb,
  total_deductions NUMERIC NOT NULL DEFAULT 0,
  net_salary NUMERIC NOT NULL,
  attendance_data JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create holidays table
CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert default settings if not exists
INSERT INTO settings (base_hourly_rate, ot1_multiplier, ot2_multiplier, base_month_salary, deductions)
SELECT 119, 1.34, 1.67, 28590, '[{"name": "勞保費", "amount": 525, "description": "勞工保險費用"}, {"name": "健保費", "amount": 372, "description": "全民健康保險費用"}]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM settings LIMIT 1);

-- Insert default holiday if not exists
INSERT INTO holidays (date, description)
SELECT '2025/01/01', '元旦'
WHERE NOT EXISTS (SELECT 1 FROM holidays WHERE date = '2025/01/01');