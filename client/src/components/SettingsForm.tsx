import type { ChangeEvent } from 'react';

import { holidayTypeOptions } from '@shared/schema';

import { Button } from '@/components/ui/button';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Input } from '@/components/ui/input';

interface SettingsFormProps {
  baseHourlyRate: number;
  baseMonthSalary: number;
  ot1Multiplier: number;
  ot2Multiplier: number;
  deductions: Array<{ name: string; amount: number; description: string }>;
  allowances: Array<{ name: string; amount: number; description: string }>;
  holidays: Array<{
    id: number;
    date: string;
    name: string;
    description?: string;
    employeeId?: number;
    holidayType?:
      | 'worked'
      | 'sick_leave'
      | 'personal_leave'
      | 'national_holiday'
      | 'typhoon_leave'
      | 'special_leave';
  }>;
  employees: Array<{ id: number; name: string; department: string }>;
  newHolidayDate: string;
  newHolidayDescription: string;
  selectedEmployeeId: number | null;
  holidayType:
    | 'worked'
    | 'sick_leave'
    | 'personal_leave'
    | 'national_holiday'
    | 'typhoon_leave'
    | 'special_leave';
  connectionStatus: 'connected' | 'disconnected' | 'testing';
  isAdmin?: boolean;
  canManageSystem?: boolean;
  databaseModeLabel?: string;
  databaseModeDescription?: string;
  databaseConnectionHint?: string;
  section?: 'salary' | 'holiday' | 'system';
  onBaseHourlyRateChange: (value: number) => void;
  onBaseMonthSalaryChange: (value: number) => void;
  onOt1MultiplierChange: (value: number) => void;
  onOt2MultiplierChange: (value: number) => void;
  onAddDeduction: () => void;
  onUpdateDeduction: (index: number, field: string, value: string | number) => void;
  onDeleteDeduction: (index: number) => void;
  onAddAllowance: () => void;
  onUpdateAllowance: (index: number, field: string, value: string | number) => void;
  onDeleteAllowance: (index: number) => void;
  onNewHolidayDateChange: (value: string) => void;
  onNewHolidayDescriptionChange: (value: string) => void;
  onSelectedEmployeeChange: (employeeId: number | null) => void;
  onHolidayTypeChange: (
    value:
      | 'worked'
      | 'sick_leave'
      | 'personal_leave'
      | 'national_holiday'
      | 'typhoon_leave'
      | 'special_leave',
  ) => void;
  onAddHoliday: () => void;
  onDeleteHoliday: (id: number) => void;
  onTestConnection: () => void;
}

type MoneyItem = {
  name: string;
  amount: number;
  description: string;
};

function NumericField({
  id,
  label,
  value,
  suffix,
  isAdmin,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  suffix: string;
  isAdmin: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-2">
      <span className="block text-sm font-medium text-gray-700">{label}</span>
      <div className="flex overflow-hidden rounded-xl border border-gray-300 bg-white">
        <Input
          id={id}
          type="number"
          value={value}
          onChange={(event) => {
            const nextValue = Number.parseFloat(event.target.value);
            if (!Number.isNaN(nextValue)) {
              onChange(nextValue);
            }
          }}
          className={`border-0 font-['Roboto_Mono'] shadow-none focus-visible:ring-0 ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
          disabled={!isAdmin}
          readOnly={!isAdmin}
        />
        <span className="inline-flex items-center border-l border-gray-300 bg-gray-50 px-3 text-sm text-gray-500">
          {suffix}
        </span>
      </div>
    </label>
  );
}

function ItemEditorSection({
  title,
  description,
  items,
  addLabel,
  emptyLabel,
  totalLabel,
  totalToneClassName,
  isAdmin,
  onAdd,
  onUpdate,
  onDelete,
}: {
  title: string;
  description: string;
  items: MoneyItem[];
  addLabel: string;
  emptyLabel: string;
  totalLabel: string;
  totalToneClassName: string;
  isAdmin: boolean;
  onAdd: () => void;
  onUpdate: (index: number, field: string, value: string | number) => void;
  onDelete: (index: number) => void;
}) {
  const totalAmount = items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  return (
    <section className="page-panel space-y-4">
      <div className="page-header">
        <div className="page-header-copy">
          <h3 className="text-lg font-medium">{title}</h3>
          <p className="page-subtitle">{description}</p>
        </div>
        {isAdmin ? (
          <Button onClick={onAdd} variant="outline" className="w-full sm:w-auto">
            {addLabel}
          </Button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          {emptyLabel}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => (
            <div key={`${title}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_auto] lg:items-end">
                <label className="space-y-2">
                  <span className="text-xs font-medium tracking-wide text-slate-500">項目名稱</span>
                  <Input
                    value={item.name}
                    onChange={(event) => onUpdate(index, 'name', event.target.value)}
                    disabled={!isAdmin}
                    readOnly={!isAdmin}
                    className={!isAdmin ? 'bg-gray-50 opacity-80' : ''}
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-xs font-medium tracking-wide text-slate-500">金額</span>
                  <Input
                    type="number"
                    value={item.amount}
                    onChange={(event) =>
                      onUpdate(index, 'amount', Number.parseFloat(event.target.value) || 0)
                    }
                    disabled={!isAdmin}
                    readOnly={!isAdmin}
                    className={`font-['Roboto_Mono'] ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-xs font-medium tracking-wide text-slate-500">描述</span>
                  <Input
                    value={item.description || ''}
                    onChange={(event) => onUpdate(index, 'description', event.target.value)}
                    disabled={!isAdmin}
                    readOnly={!isAdmin}
                    className={!isAdmin ? 'bg-gray-50 opacity-80' : ''}
                  />
                </label>

                {isAdmin ? (
                  <Button
                    variant="outline"
                    className="w-full text-red-600 hover:bg-red-50 hover:text-red-700 lg:w-auto"
                    onClick={() => onDelete(index)}
                  >
                    刪除
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={`rounded-xl px-4 py-3 text-right text-sm font-medium ${totalToneClassName}`}>
        {totalLabel} {totalAmount.toLocaleString('zh-TW')}
      </div>
    </section>
  );
}

function getHolidayBadgeClassName(holidayType?: SettingsFormProps['holidayType']) {
  switch (holidayType) {
    case 'national_holiday':
      return 'bg-green-100 text-green-700';
    case 'special_leave':
      return 'bg-teal-100 text-teal-700';
    case 'sick_leave':
      return 'bg-yellow-100 text-yellow-700';
    case 'personal_leave':
      return 'bg-orange-100 text-orange-700';
    case 'typhoon_leave':
      return 'bg-purple-100 text-purple-700';
    case 'worked':
      return 'bg-blue-100 text-blue-700';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

export default function SettingsForm({
  baseHourlyRate,
  baseMonthSalary,
  ot1Multiplier,
  ot2Multiplier,
  deductions,
  allowances,
  holidays,
  employees,
  newHolidayDate,
  newHolidayDescription,
  selectedEmployeeId,
  holidayType,
  connectionStatus,
  isAdmin = false,
  canManageSystem = false,
  databaseModeLabel = '外部 PostgreSQL',
  databaseModeDescription = '資料庫連線由伺服器端 DATABASE_URL 管理，與應用容器生命週期分離。',
  databaseConnectionHint = '實際連線目標由伺服器端 DATABASE_URL 管理，前端不提供資料源切換。',
  section,
  onBaseHourlyRateChange,
  onBaseMonthSalaryChange,
  onOt1MultiplierChange,
  onOt2MultiplierChange,
  onAddDeduction,
  onUpdateDeduction,
  onDeleteDeduction,
  onAddAllowance,
  onUpdateAllowance,
  onDeleteAllowance,
  onNewHolidayDateChange,
  onNewHolidayDescriptionChange,
  onSelectedEmployeeChange,
  onHolidayTypeChange,
  onAddHoliday,
  onDeleteHoliday,
  onTestConnection,
}: SettingsFormProps) {
  const showSalary = !section || section === 'salary';
  const showHoliday = !section || section === 'holiday';
  const showSystem = !section || section === 'system';

  return (
    <div className="page-stack">
      {showSalary ? (
        <>
          <section className="page-panel space-y-4">
            <div className="page-header-copy">
              <h3 className="text-lg font-medium">薪資計算設定</h3>
              <p className="page-subtitle">以手機優先排列欄位，桌面再自動擴展成雙欄編輯版面。</p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <NumericField
                id="baseHourlyRate"
                label="基本時薪"
                value={baseHourlyRate}
                suffix="元/小時"
                isAdmin={isAdmin}
                onChange={onBaseHourlyRateChange}
              />
              <NumericField
                id="baseMonthSalary"
                label="基本月薪"
                value={baseMonthSalary}
                suffix="元/月"
                isAdmin={isAdmin}
                onChange={onBaseMonthSalaryChange}
              />
              <NumericField
                id="ot1Multiplier"
                label="加班倍率 (前2小時)"
                value={ot1Multiplier}
                suffix="倍"
                isAdmin={isAdmin}
                onChange={onOt1MultiplierChange}
              />
              <NumericField
                id="ot2Multiplier"
                label="加班倍率 (超過2小時)"
                value={ot2Multiplier}
                suffix="倍"
                isAdmin={isAdmin}
                onChange={onOt2MultiplierChange}
              />
            </div>
          </section>

          <ItemEditorSection
            title="扣款項目設定"
            description="每一筆扣款會在薪資計算與明細輸出中同步反映。"
            items={deductions}
            addLabel="新增扣款項目"
            emptyLabel="目前沒有扣款項目。"
            totalLabel="扣款總額："
            totalToneClassName="bg-red-50 text-red-700"
            isAdmin={isAdmin}
            onAdd={onAddDeduction}
            onUpdate={onUpdateDeduction}
            onDelete={onDeleteDeduction}
          />

          <ItemEditorSection
            title="津貼與福利調整"
            description="可在此維護住房、福利或其他自訂津貼。"
            items={allowances}
            addLabel="新增津貼項目"
            emptyLabel="目前沒有津貼項目。"
            totalLabel="津貼總額："
            totalToneClassName="bg-green-50 text-green-700"
            isAdmin={isAdmin}
            onAdd={onAddAllowance}
            onUpdate={onUpdateAllowance}
            onDelete={onDeleteAllowance}
          />
        </>
      ) : null}

      {showHoliday ? (
        <section className="page-panel space-y-4">
          <div className="page-header">
            <div className="page-header-copy">
              <h3 className="text-lg font-medium">假日設定</h3>
              <p className="page-subtitle">集中管理國定假日、特休與扣薪假別。</p>
            </div>
            {isAdmin ? (
              <Button
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => {
                  alert('此功能尚未實作');
                }}
              >
                匯入假日
              </Button>
            ) : null}
          </div>

          {isAdmin ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="grid gap-3 lg:grid-cols-3">
                <select
                  value={selectedEmployeeId || ''}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    onSelectedEmployeeChange(event.target.value ? Number(event.target.value) : null)
                  }
                  className="h-10 rounded-md border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">選擇員工...</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name} ({employee.department})
                    </option>
                  ))}
                </select>

                <DateTimePicker
                  mode="date"
                  value={newHolidayDate}
                  onChange={onNewHolidayDateChange}
                  placeholder="選擇日期..."
                  className="w-full"
                />

                <select
                  value={holidayType}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    onHolidayTypeChange(event.target.value as SettingsFormProps['holidayType'])
                  }
                  className="h-10 rounded-md border border-gray-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  data-testid="select-holiday-type"
                >
                  {holidayTypeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <Input
                  value={newHolidayDescription}
                  onChange={(event) => onNewHolidayDescriptionChange(event.target.value)}
                  placeholder="假日描述 (選填)"
                  className="flex-1"
                />
                <Button
                  onClick={onAddHoliday}
                  disabled={!selectedEmployeeId || !newHolidayDate}
                  className="w-full sm:w-auto"
                >
                  新增假日
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm italic text-slate-500">
              登入管理員後方可新增假日
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {holidays.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500 md:col-span-2 xl:col-span-3">
                尚未設定假日
              </div>
            ) : (
              holidays.map((holiday) => {
                const employee = employees.find((item) => item.id === holiday.employeeId);
                const holidayOption = holidayTypeOptions.find((option) => option.value === holiday.holidayType);

                return (
                  <div key={holiday.id} className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-2">
                        <div className="font-['Roboto_Mono'] text-sm font-medium text-slate-700" data-testid="holiday-date">
                          {holiday.date}
                        </div>
                        {employee ? (
                          <div className="text-sm font-medium text-blue-600" data-testid="holiday-employee">
                            {employee.name}
                          </div>
                        ) : null}
                        {holiday.name ? (
                          <div className="text-sm text-slate-700" data-testid="holiday-name">
                            {holiday.name}
                          </div>
                        ) : null}
                      </div>

                      {isAdmin ? (
                        <Button
                          variant="outline"
                          className="shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700"
                          onClick={() => onDeleteHoliday(holiday.id)}
                          data-testid="button-delete-holiday"
                        >
                          刪除
                        </Button>
                      ) : null}
                    </div>

                    {holidayOption ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${getHolidayBadgeClassName(holiday.holidayType)}`}
                          data-testid="holiday-type-badge"
                        >
                          {holidayOption.label}
                        </span>
                        <span className="text-xs text-slate-500">{holidayOption.description}</span>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </section>
      ) : null}

      {showSystem && isAdmin && canManageSystem ? (
        <section className="page-panel space-y-4">
          <div className="page-header-copy">
            <h3 className="text-lg font-medium">資料庫與部署狀態</h3>
            <p className="page-subtitle">{databaseModeDescription}</p>
          </div>

          <div className="rounded-xl border border-green-200 bg-green-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="font-medium text-green-800">目前運行模式：{databaseModeLabel}</div>
                <div className="mt-1 text-sm text-green-700">{databaseModeDescription}</div>
              </div>
              <span className="inline-flex w-fit rounded-full border border-green-200 bg-white px-3 py-1 text-xs font-medium text-green-800">
                Production Baseline
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4">
            <div className="text-sm font-medium text-slate-700">資料庫連線狀態</div>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                {connectionStatus === 'connected' ? (
                  <span className="text-green-700">PostgreSQL 連線正常</span>
                ) : null}
                {connectionStatus === 'disconnected' ? (
                  <span className="text-red-700">PostgreSQL 連線異常</span>
                ) : null}
                {connectionStatus === 'testing' ? (
                  <span className="text-amber-700">檢查中...</span>
                ) : null}
              </div>
              <Button
                onClick={onTestConnection}
                disabled={connectionStatus === 'testing'}
                className="w-full sm:w-auto"
              >
                重新檢查
              </Button>
            </div>
            <div className="mt-3 text-xs text-slate-500">{databaseConnectionHint}</div>
          </div>
        </section>
      ) : null}

      {showSystem && isAdmin && !canManageSystem ? (
        <section className="page-panel">
          <h3 className="text-lg font-medium">系統診斷</h3>
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            系統診斷與部署檢查只開放給 super admin，這樣可以避免一般管理員誤觸敏感維運功能。
          </div>
        </section>
      ) : null}
    </div>
  );
}
