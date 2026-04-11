import { useToast } from "@/hooks/use-toast";
import { useSettingsForm } from '@/hooks/useSettingsForm';
import SettingsForm from '@/components/SettingsForm';
import SpecialLeaveCounter from '@/components/SpecialLeaveCounter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Lock, Shield, Loader2, Save, AlertCircle, DollarSign, CalendarDays, Settings, ScanLine } from 'lucide-react';
import AdminLoginDialog from '@/components/AdminLoginDialog';

export default function SettingsPage() {
  const { toast } = useToast();
  const {
    // Admin auth
    isAdmin, isSuperAdmin, logout,
    isLoginModalOpen, setIsLoginModalOpen,
    showChangePin, setShowChangePin,
    currentPin, setCurrentPin,
    newPin, setNewPin,
    confirmPin, setConfirmPin,
    isChangingPin, handleChangePin,
    // Salary form
    baseHourlyRate, setBaseHourlyRate,
    baseMonthSalary, setBaseMonthSalary,
    ot1Multiplier, setOt1Multiplier,
    ot2Multiplier, setOt2Multiplier,
    deductions, allowances,
    hasUnsavedChanges, isSaving,
    handleSaveSettings,
    handleAddDeduction, handleUpdateDeduction, handleDeleteDeduction,
    handleAddAllowance, handleUpdateAllowance, handleDeleteAllowance,
    // Barcode
    barcodeEnabled, confirmDisableBarcode, setConfirmDisableBarcode,
    isBarcodeToggling, handleDisableBarcode, handleEnableBarcode,
    // Holiday
    holidays,
    newHolidayDate, setNewHolidayDate,
    newHolidayDescription, setNewHolidayDescription,
    selectedEmployeeId, setSelectedEmployeeId,
    holidayType, setHolidayType,
    handleAddHoliday, handleDeleteHoliday,
    // Employees
    normalizedEmployees,
    // Database status
    connectionStatus,
    databaseModeLabel, databaseModeDescription, databaseConnectionHint,
    refreshDatabaseStatus,
  } = useSettingsForm();

  const commonFormProps = {
    baseHourlyRate, baseMonthSalary, ot1Multiplier, ot2Multiplier,
    deductions, allowances,
    holidays: Array.isArray(holidays) ? holidays : [],
    employees: normalizedEmployees,
    newHolidayDate, newHolidayDescription, selectedEmployeeId, holidayType,
    connectionStatus,
    isAdmin,
    canManageSystem: isSuperAdmin,
    onBaseHourlyRateChange: setBaseHourlyRate,
    onBaseMonthSalaryChange: setBaseMonthSalary,
    onOt1MultiplierChange: setOt1Multiplier,
    onOt2MultiplierChange: setOt2Multiplier,
    onAddDeduction: handleAddDeduction,
    onUpdateDeduction: handleUpdateDeduction,
    onDeleteDeduction: handleDeleteDeduction,
    onAddAllowance: handleAddAllowance,
    onUpdateAllowance: handleUpdateAllowance,
    onDeleteAllowance: handleDeleteAllowance,
    onNewHolidayDateChange: setNewHolidayDate,
    onNewHolidayDescriptionChange: setNewHolidayDescription,
    onSelectedEmployeeChange: setSelectedEmployeeId,
    onHolidayTypeChange: setHolidayType,
    onAddHoliday: handleAddHoliday,
    onDeleteHoliday: handleDeleteHoliday,
    onTestConnection: () => { void refreshDatabaseStatus(true); },
  };

  const renderAdminSection = () => {
    if (!isAdmin) {
      return (
        <div className="mt-8 p-6 border border-gray-200 rounded-lg bg-gray-50">
          <div className="flex flex-col items-center justify-center gap-4">
            <Lock className="w-12 h-12 text-gray-400" />
            <h3 className="text-lg font-medium text-gray-700">管理員功能區</h3>
            <p className="text-gray-500 text-center">您需要管理員權限才能訪問此區域的功能。</p>
            <Button onClick={() => setIsLoginModalOpen(true)} className="mt-2" variant="outline">
              <Shield className="w-4 h-4 mr-2" />
              管理員登入
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="mt-8 p-6 border border-primary/20 rounded-lg bg-primary/5">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-medium text-primary flex items-center">
            <Shield className="w-5 h-5 mr-2" />
            管理員控制面板
          </h3>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowChangePin(!showChangePin)}>
              {showChangePin ? '取消' : '更改PIN碼'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { void logout(); }}>
              登出管理員
            </Button>
          </div>
        </div>

        {/* Barcode scanner toggle */}
        <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ScanLine className="w-4 h-4 text-gray-600" />
              <div>
                <h4 className="font-medium text-sm">掃碼槍功能</h4>
                <p className="text-xs text-gray-500 mt-0.5">
                  {barcodeEnabled
                    ? '目前已啟用，硬體掃碼槍與瀏覽器掃碼均可使用'
                    : '目前已停用，僅保留 LINE QR Code 打卡'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${barcodeEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                {barcodeEnabled ? '已啟用' : '已停用'}
              </span>
              {barcodeEnabled ? (
                <Button variant="outline" size="sm" disabled={isBarcodeToggling} onClick={() => setConfirmDisableBarcode(true)}>
                  停用掃碼槍
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={isBarcodeToggling} onClick={() => void handleEnableBarcode()}>
                  {isBarcodeToggling && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                  重新啟用
                </Button>
              )}
            </div>
          </div>

          {confirmDisableBarcode && (
            <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-md">
              <p className="text-sm text-amber-800 mb-1 font-medium">確認停用掃碼槍？</p>
              <p className="text-xs text-amber-700 mb-3">
                停用後系統將自動以 AES-256-GCM 加密所有明文儲存的員工身分證（加密後無法自動還原明文）。掃碼槍 API 端點將立即停止回應。開關本身可隨時重新啟用。
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={isBarcodeToggling}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                  onClick={() => void handleDisableBarcode()}
                >
                  {isBarcodeToggling && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                  確認停用並加密
                </Button>
                <Button size="sm" variant="outline" disabled={isBarcodeToggling} onClick={() => setConfirmDisableBarcode(false)}>
                  取消
                </Button>
              </div>
            </div>
          )}
        </div>

        {showChangePin && (
          <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-white">
            <h4 className="font-medium mb-4">更改管理員PIN碼</h4>
            <div className="grid gap-4">
              <div>
                <label htmlFor="currentPin" className="block text-sm font-medium mb-1">目前PIN碼</label>
                <Input
                  id="currentPin"
                  type="password"
                  maxLength={6}
                  pattern="[0-9]*"
                  inputMode="numeric"
                  placeholder="請輸入目前的6位數PIN碼"
                  value={currentPin}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const value = e.target.value.replace(/[^0-9]/g, '');
                    if (value.length <= 6) setCurrentPin(value);
                  }}
                />
              </div>
              <div>
                <label htmlFor="newPin" className="block text-sm font-medium mb-1">新PIN碼</label>
                <Input
                  id="newPin"
                  type="password"
                  maxLength={6}
                  pattern="[0-9]*"
                  inputMode="numeric"
                  placeholder="請輸入新的6位數PIN碼"
                  value={newPin}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const value = e.target.value.replace(/[^0-9]/g, '');
                    if (value.length <= 6) setNewPin(value);
                  }}
                />
              </div>
              <div>
                <label htmlFor="confirmPin" className="block text-sm font-medium mb-1">確認PIN碼</label>
                <Input
                  id="confirmPin"
                  type="password"
                  maxLength={6}
                  pattern="[0-9]*"
                  inputMode="numeric"
                  placeholder="請再次輸入新的6位數PIN碼"
                  value={confirmPin}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const value = e.target.value.replace(/[^0-9]/g, '');
                    if (value.length <= 6) setConfirmPin(value);
                  }}
                />
              </div>
              <Button
                onClick={handleChangePin}
                disabled={currentPin.length !== 6 || newPin.length !== 6 || confirmPin.length !== 6 || isChangingPin}
                className="mt-2"
              >
                {isChangingPin && <span className="mr-2"><Loader2 className="w-4 h-4 animate-spin" /></span>}
                確認更改
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">系統設定</h2>
        <div>
          {isAdmin ? (
            <div className="bg-primary/10 px-3 py-1 rounded-full text-primary text-sm font-medium flex items-center">
              <Shield className="w-4 h-4 mr-1" />
              管理員模式
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setIsLoginModalOpen(true)} className="text-gray-500">
              <Lock className="w-4 h-4 mr-1" />
              管理員登入
            </Button>
          )}
        </div>
      </div>

      {hasUnsavedChanges && isAdmin && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 relative flex items-start">
          <AlertCircle className="h-4 w-4 text-yellow-600 mt-1 mr-2" />
          <div className="text-sm text-yellow-800">
            您有未儲存的變更。請記得儲存設定以套用變更。
          </div>
        </div>
      )}

      <Tabs defaultValue="salary" className="w-full">
        <TabsList className="grid w-full grid-cols-3 mb-6">
          <TabsTrigger value="salary" className="flex items-center gap-2">
            <DollarSign className="w-4 h-4" /><span>薪資設定</span>
          </TabsTrigger>
          <TabsTrigger value="holiday" className="flex items-center gap-2">
            <CalendarDays className="w-4 h-4" /><span>假日與特休</span>
          </TabsTrigger>
          <TabsTrigger value="system" className="flex items-center gap-2">
            <Settings className="w-4 h-4" /><span>系統管理</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="salary">
          <SettingsForm {...commonFormProps} section="salary" />
          {isAdmin && (
            <div className="mt-6 flex justify-end">
              <Button
                onClick={handleSaveSettings}
                disabled={isSaving || !isAdmin || !hasUnsavedChanges}
                className={`${hasUnsavedChanges ? 'bg-success hover:bg-green-600' : 'bg-gray-400'} text-white px-8 py-3 rounded-md font-medium`}
              >
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {isSaving ? '儲存中...' : '儲存薪資設定'}
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="holiday">
          <SettingsForm {...commonFormProps} section="holiday" />
          <div className="mt-6">
            <SpecialLeaveCounter
              employees={normalizedEmployees}
              isAdmin={isAdmin}
              baseSalary={baseMonthSalary}
            />
          </div>
        </TabsContent>

        <TabsContent value="system">
          <div className="bg-white p-6 rounded-lg shadow-sm">
            <h3 className="text-lg font-medium mb-4">資料庫與部署狀態</h3>
            <div className="space-y-4">
              <div className="rounded-md border border-green-200 bg-green-50 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-medium text-green-800">目前運行模式：{databaseModeLabel}</div>
                    <div className="mt-1 text-sm text-green-700">{databaseModeDescription}</div>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-green-800 border border-green-200">
                    Production Baseline
                  </span>
                </div>
              </div>

              {isSuperAdmin ? (
                <div className="rounded-md border border-gray-200 p-4">
                  <div className="mb-2 text-sm font-medium text-gray-700">資料庫連線狀態</div>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center text-sm">
                      {connectionStatus === 'connected' && (
                        <><span className="material-icons text-success text-sm mr-1">check_circle</span><span className="text-success">{databaseModeLabel} 連線正常</span></>
                      )}
                      {connectionStatus === 'disconnected' && (
                        <><span className="material-icons text-error text-sm mr-1">error</span><span className="text-error">{databaseModeLabel} 連線異常</span></>
                      )}
                      {connectionStatus === 'testing' && (
                        <><span className="material-icons text-warning text-sm mr-1 animate-spin">sync</span><span className="text-warning">檢查中...</span></>
                      )}
                    </div>
                    <Button
                      onClick={() => { void refreshDatabaseStatus(true); }}
                      disabled={connectionStatus === 'testing'}
                      className="bg-primary hover:bg-blue-700 text-white px-4 py-2 rounded-md"
                    >
                      重新檢查
                    </Button>
                  </div>
                  <div className="mt-3 text-xs text-gray-500">{databaseConnectionHint}</div>
                </div>
              ) : (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  系統診斷與部署檢查只開放給 super admin，避免一般管理員誤觸敏感維運功能。
                </div>
              )}
            </div>
          </div>

          {renderAdminSection()}
        </TabsContent>
      </Tabs>

      <AdminLoginDialog
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onSuccess={() => {
          toast({ title: '管理員驗證成功', description: '您已進入管理員模式' });
        }}
      />
    </div>
  );
}
