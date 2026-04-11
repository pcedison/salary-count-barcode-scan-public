import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { holidayTypeOptions } from '@shared/schema';

interface SettingsFormProps {
  baseHourlyRate: number;
  baseMonthSalary: number;
  ot1Multiplier: number;
  ot2Multiplier: number;
  deductions: Array<{ name: string; amount: number; description: string }>;
  allowances: Array<{ name: string; amount: number; description: string }>;
  holidays: Array<{ id: number; date: string; name: string; description?: string; employeeId?: number; holidayType?: 'worked' | 'sick_leave' | 'personal_leave' | 'national_holiday' | 'typhoon_leave' | 'special_leave' }>;
  employees: Array<{ id: number; name: string; department: string }>;
  newHolidayDate: string;
  newHolidayDescription: string;
  selectedEmployeeId: number | null;
  holidayType: 'worked' | 'sick_leave' | 'personal_leave' | 'national_holiday' | 'typhoon_leave' | 'special_leave';
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
  onHolidayTypeChange: (value: 'worked' | 'sick_leave' | 'personal_leave' | 'national_holiday' | 'typhoon_leave' | 'special_leave') => void;
  onAddHoliday: () => void;
  onDeleteHoliday: (id: number) => void;
  onTestConnection: () => void;
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
  onTestConnection
}: SettingsFormProps) {
  const handleNumericChange = (setter: (value: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    if (!isNaN(value)) {
      setter(value);
    }
  };

  const showSalary = !section || section === 'salary';
  const showHoliday = !section || section === 'holiday';
  const showSystem = !section || section === 'system';

  return (
    <div className="space-y-8">
      {showSalary && (
        <>
          <div className="bg-white p-6 rounded-lg shadow-sm">
            <h3 className="text-lg font-medium mb-4">薪資計算設定</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label htmlFor="baseHourlyRate" className="block text-sm font-medium text-gray-700">基本時薪</label>
                <div className="flex">
                  <Input
                    id="baseHourlyRate"
                    type="number"
                    value={baseHourlyRate}
                    onChange={handleNumericChange(onBaseHourlyRateChange)}
                    className={`w-full px-4 py-2 border border-gray-300 rounded-l-md focus:ring-primary focus:border-primary font-['Roboto_Mono'] ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                    step="0.01"
                    disabled={!isAdmin}
                    readOnly={!isAdmin}
                  />
                  <span className="inline-flex items-center px-3 py-2 rounded-r-md border border-l-0 border-gray-300 bg-gray-50 text-gray-500">元/小時</span>
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="baseMonthSalary" className="block text-sm font-medium text-gray-700">基本月薪</label>
                <div className="flex">
                  <Input
                    id="baseMonthSalary"
                    type="number"
                    value={baseMonthSalary}
                    onChange={handleNumericChange(onBaseMonthSalaryChange)}
                    className={`w-full px-4 py-2 border border-gray-300 rounded-l-md focus:ring-primary focus:border-primary font-['Roboto_Mono'] ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                    disabled={!isAdmin}
                    readOnly={!isAdmin}
                  />
                  <span className="inline-flex items-center px-3 py-2 rounded-r-md border border-l-0 border-gray-300 bg-gray-50 text-gray-500">元/月</span>
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="ot1Multiplier" className="block text-sm font-medium text-gray-700">加班倍率 (前2小時)</label>
                <div className="flex">
                  <Input
                    id="ot1Multiplier"
                    type="number"
                    value={ot1Multiplier}
                    onChange={handleNumericChange(onOt1MultiplierChange)}
                    className={`w-full px-4 py-2 border border-gray-300 rounded-l-md focus:ring-primary focus:border-primary font-['Roboto_Mono'] ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                    step="0.01"
                    disabled={!isAdmin}
                    readOnly={!isAdmin}
                  />
                  <span className="inline-flex items-center px-3 py-2 rounded-r-md border border-l-0 border-gray-300 bg-gray-50 text-gray-500">倍</span>
                </div>
              </div>
              <div className="space-y-2">
                <label htmlFor="ot2Multiplier" className="block text-sm font-medium text-gray-700">加班倍率 (超過2小時)</label>
                <div className="flex">
                  <Input
                    id="ot2Multiplier"
                    type="number"
                    value={ot2Multiplier}
                    onChange={handleNumericChange(onOt2MultiplierChange)}
                    className={`w-full px-4 py-2 border border-gray-300 rounded-l-md focus:ring-primary focus:border-primary font-['Roboto_Mono'] ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                    step="0.01"
                    disabled={!isAdmin}
                    readOnly={!isAdmin}
                  />
                  <span className="inline-flex items-center px-3 py-2 rounded-r-md border border-l-0 border-gray-300 bg-gray-50 text-gray-500">倍</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium">扣款項目設定</h3>
              {isAdmin && (
                <button
                  className="text-primary hover:text-blue-700 text-sm flex items-center"
                  onClick={onAddDeduction}
                >
                  <span className="material-icons text-sm mr-1">add_circle</span>
                  新增項目
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">項目名稱</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">金額</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">描述</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {deductions.map((deduction, index) => (
                    <tr key={index} className={index % 2 === 1 ? 'bg-gray-50' : ''}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Input
                          value={deduction.name}
                          onChange={(e) => onUpdateDeduction(index, 'name', e.target.value)}
                          className={`px-2 py-1 border border-gray-300 rounded-md ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                          disabled={!isAdmin}
                          readOnly={!isAdmin}
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <Input
                          type="number"
                          value={deduction.amount}
                          onChange={(e) => onUpdateDeduction(index, 'amount', parseFloat(e.target.value))}
                          className={`px-2 py-1 border border-gray-300 rounded-md w-24 mx-auto font-['Roboto_Mono'] ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                          disabled={!isAdmin}
                          readOnly={!isAdmin}
                        />
                      </td>
                      <td className="px-6 py-4">
                        <Input
                          value={deduction.description || ''}
                          onChange={(e) => onUpdateDeduction(index, 'description', e.target.value)}
                          className={`px-2 py-1 border border-gray-300 rounded-md ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                          disabled={!isAdmin}
                          readOnly={!isAdmin}
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        {isAdmin && (
                          <button
                            className="text-error hover:text-red-700"
                            onClick={() => onDeleteDeduction(index)}
                          >
                            <span className="material-icons text-sm">delete</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium">津貼與福利調整</h3>
              {isAdmin && (
                <button
                  className="text-primary hover:text-blue-700 text-sm flex items-center"
                  onClick={onAddAllowance}
                >
                  <span className="material-icons text-sm mr-1">add_circle</span>
                  新增項目
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">項目名稱</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">金額</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">描述</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {allowances.map((allowance, index) => (
                    <tr key={index} className={index % 2 === 1 ? 'bg-gray-50' : ''}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Input
                          value={allowance.name}
                          onChange={(e) => onUpdateAllowance(index, 'name', e.target.value)}
                          className={`px-2 py-1 border border-gray-300 rounded-md ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                          disabled={!isAdmin}
                          readOnly={!isAdmin}
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <Input
                          type="number"
                          value={allowance.amount}
                          onChange={(e) => onUpdateAllowance(index, 'amount', parseFloat(e.target.value))}
                          className={`px-2 py-1 border border-gray-300 rounded-md w-24 mx-auto font-['Roboto_Mono'] ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                          disabled={!isAdmin}
                          readOnly={!isAdmin}
                        />
                      </td>
                      <td className="px-6 py-4">
                        <Input
                          value={allowance.description || ''}
                          onChange={(e) => onUpdateAllowance(index, 'description', e.target.value)}
                          className={`px-2 py-1 border border-gray-300 rounded-md ${!isAdmin ? 'bg-gray-50 opacity-80' : ''}`}
                          disabled={!isAdmin}
                          readOnly={!isAdmin}
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        {isAdmin && (
                          <button
                            className="text-error hover:text-red-700"
                            onClick={() => onDeleteAllowance(index)}
                          >
                            <span className="material-icons text-sm">delete</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showHoliday && (
        <div className="bg-white p-6 rounded-lg shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-medium">假日設定</h3>
            {isAdmin && (
              <button
                className="text-primary hover:text-blue-700 text-sm flex items-center"
                onClick={() => {
                  alert('此功能尚未實作');
                }}
              >
                <span className="material-icons text-sm mr-1">file_upload</span>
                匯入假日
              </button>
            )}
          </div>
          {isAdmin ? (
            <div className="space-y-3 mb-4">
              <div className="flex gap-2">
                <div className="flex-1">
                  <select
                    value={selectedEmployeeId || ''}
                    onChange={(e) => onSelectedEmployeeChange(e.target.value ? Number(e.target.value) : null)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">選擇員工...</option>
                    {employees?.map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name} ({employee.department})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <DateTimePicker
                    mode="date"
                    value={newHolidayDate}
                    onChange={onNewHolidayDateChange}
                    placeholder="選擇日期..."
                    className="w-full"
                  />
                </div>
                <div className="flex-1">
                  <select
                    value={holidayType}
                    onChange={(e) => onHolidayTypeChange(e.target.value as 'worked' | 'sick_leave' | 'personal_leave' | 'national_holiday' | 'typhoon_leave' | 'special_leave')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    data-testid="select-holiday-type"
                  >
                    <option value="national_holiday">國定假日</option>
                    <option value="special_leave">特別休假</option>
                    <option value="sick_leave">病假</option>
                    <option value="personal_leave">事假</option>
                    <option value="typhoon_leave">颱風假</option>
                    <option value="worked">假日出勤</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  value={newHolidayDescription}
                  onChange={(e) => onNewHolidayDescriptionChange(e.target.value)}
                  placeholder="假日描述 (選填)"
                  className="flex-1"
                />
                <Button
                  onClick={onAddHoliday}
                  disabled={!selectedEmployeeId || !newHolidayDate}
                  className="bg-primary hover:bg-blue-700 text-white px-4 py-2 rounded-md disabled:opacity-50"
                >
                  新增假日
                </Button>
              </div>
            </div>
          ) : (
            <div className="mb-4 text-sm text-gray-500 italic">
              登入管理員後方可新增假日
            </div>
          )}
          <div className="bg-gray-50 p-4 rounded-md flex flex-wrap gap-2">
            {holidays.length === 0 ? (
              <div className="w-full text-center py-4 text-gray-500">尚未設定假日</div>
            ) : (
              holidays.map((holiday) => {
                const employee = employees?.find(emp => emp.id === holiday.employeeId);
                return (
                  <div key={holiday.id} className="bg-white px-3 py-1 rounded-md border border-gray-200 flex items-center" data-testid={`holiday-item-${holiday.id}`}>
                    <span className="font-['Roboto_Mono'] mr-2" data-testid="holiday-date">{holiday.date}</span>
                    {employee && (
                      <span className="text-sm font-medium text-blue-600 mr-2" data-testid="holiday-employee">{employee.name}</span>
                    )}
                    {holiday.name && (
                      <span className="text-sm text-gray-700 mr-2" data-testid="holiday-name">{holiday.name}</span>
                    )}
                    {holiday.holidayType && (
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full mr-2 ${
                          holiday.holidayType === 'national_holiday' ? 'bg-green-100 text-green-700' :
                          holiday.holidayType === 'special_leave' ? 'bg-teal-100 text-teal-700' :
                          holiday.holidayType === 'sick_leave' ? 'bg-yellow-100 text-yellow-700' :
                          holiday.holidayType === 'personal_leave' ? 'bg-orange-100 text-orange-700' :
                          holiday.holidayType === 'typhoon_leave' ? 'bg-purple-100 text-purple-700' :
                          holiday.holidayType === 'worked' ? 'bg-blue-100 text-blue-700' :
                          'bg-gray-100 text-gray-700'
                        }`}
                        data-testid="holiday-type-badge"
                      >
                        {holidayTypeOptions.find(opt => opt.value === holiday.holidayType)?.label}
                      </span>
                    )}
                    {isAdmin && (
                      <button
                        className="text-error hover:text-red-700"
                        onClick={() => onDeleteHoliday(holiday.id)}
                        data-testid="button-delete-holiday"
                      >
                        <span className="material-icons text-sm">close</span>
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {showSystem && isAdmin && canManageSystem && (
        <div className="bg-white p-6 rounded-lg shadow-sm">
          <h3 className="text-lg font-medium mb-4">資料庫與部署狀態</h3>

          <div className="space-y-4">
            <div className="rounded-md border border-green-200 bg-green-50 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium text-green-800">目前運行模式：PostgreSQL-only</div>
                  <div className="mt-1 text-sm text-green-700">
                    生產策略已固定為單一 PostgreSQL 存儲。資料庫切換、Supabase 設定與遷移入口已停用，避免誤操作。
                  </div>
                </div>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-green-800 border border-green-200">
                  Production Baseline
                </span>
              </div>
            </div>

            <div className="rounded-md border border-gray-200 p-4">
              <div className="mb-2 text-sm font-medium text-gray-700">資料庫連線狀態</div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center text-sm">
                  {connectionStatus === 'connected' && (
                    <>
                      <span className="material-icons text-success text-sm mr-1">check_circle</span>
                      <span className="text-success">PostgreSQL 連線正常</span>
                    </>
                  )}
                  {connectionStatus === 'disconnected' && (
                    <>
                      <span className="material-icons text-error text-sm mr-1">error</span>
                      <span className="text-error">PostgreSQL 連線異常</span>
                    </>
                  )}
                  {connectionStatus === 'testing' && (
                    <>
                      <span className="material-icons text-warning text-sm mr-1 animate-spin">sync</span>
                      <span className="text-warning">檢查中...</span>
                    </>
                  )}
                </div>
                <Button
                  onClick={onTestConnection}
                  disabled={connectionStatus === 'testing'}
                  className="bg-primary hover:bg-blue-700 text-white px-4 py-2 rounded-md"
                >
                  重新檢查
                </Button>
              </div>
              <div className="mt-3 text-xs text-gray-500">
                實際連線由伺服器端 `DATABASE_URL` 管理，不接受前端 UI 直接切換。
              </div>
            </div>
          </div>
        </div>
      )}

      {showSystem && isAdmin && !canManageSystem && (
        <div className="bg-white p-6 rounded-lg shadow-sm">
          <h3 className="text-lg font-medium mb-4">系統診斷</h3>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            系統診斷與部署檢查只開放給 super admin，這樣可以避免一般管理員誤觸敏感維運功能。
          </div>
        </div>
      )}
    </div>
  );
}
