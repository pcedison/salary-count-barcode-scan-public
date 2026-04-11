import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useSettings } from '@/hooks/useSettings';
import { useAdmin } from '@/hooks/useAdmin';
import { useEmployees } from '@/hooks/useEmployees';
import { apiRequest } from '@/lib/queryClient';
import { constants } from '@/lib/constants';

const DEFAULT_CONFIG = {
  BASE_HOURLY_RATE: constants.BASE_HOURLY_RATE,
  BASE_MONTH_SALARY: constants.BASE_HOURLY_RATE * constants.STANDARD_WORK_DAYS * constants.STANDARD_WORK_HOURS,
  WELFARE_ALLOWANCE: constants.DEFAULT_WELFARE_ALLOWANCE,
  HOUSING_ALLOWANCE: constants.DEFAULT_HOUSING_ALLOWANCE,
  OT1_MULTIPLIER: constants.OT1_MULTIPLIER,
  OT2_MULTIPLIER: constants.OT2_MULTIPLIER,
  DEDUCTIONS: [
    { id: 1, name: '勞保費', amount: 658, description: '勞工保險費用' },
    { id: 2, name: '健保費', amount: 443, description: '全民健康保險費用' },
    { id: 3, name: '服務費', amount: 1800, description: '公司服務費' },
    { id: 4, name: '宿舍費', amount: 2500, description: '員工宿舍住宿費' }
  ]
};

export interface DeductionItem {
  name: string;
  amount: number;
  description: string;
}

export interface AllowanceItem {
  name: string;
  amount: number;
  description: string;
}

export function useSettingsForm() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAdmin, isSuperAdmin, updatePin, logout } = useAdmin();
  const { settings, isLoading, updateSettings, holidays, isHolidaysLoading, addHoliday, deleteHoliday } =
    useSettings({ requireAdminSettings: isAdmin });
  const { employees } = useEmployees({ requireAdminDetails: isAdmin });

  const normalizedEmployees = employees.map((employee) => ({
    ...employee,
    department: employee.department ?? '',
    position: employee.position ?? undefined,
    specialLeaveWorkDateRange: employee.specialLeaveWorkDateRange ?? undefined,
    specialLeaveCashMonth: employee.specialLeaveCashMonth ?? undefined,
    specialLeaveNotes: employee.specialLeaveNotes ?? undefined,
  }));

  // --- Salary form state ---
  const [baseHourlyRate, setBaseHourlyRate] = useState<number>(DEFAULT_CONFIG.BASE_HOURLY_RATE);
  const [baseMonthSalary, setBaseMonthSalary] = useState<number>(DEFAULT_CONFIG.BASE_MONTH_SALARY);
  const [ot1Multiplier, setOt1Multiplier] = useState<number>(DEFAULT_CONFIG.OT1_MULTIPLIER);
  const [ot2Multiplier, setOt2Multiplier] = useState<number>(DEFAULT_CONFIG.OT2_MULTIPLIER);
  const [deductions, setDeductions] = useState<DeductionItem[]>(DEFAULT_CONFIG.DEDUCTIONS);
  const [allowances, setAllowances] = useState<AllowanceItem[]>([
    { name: '福利金', amount: DEFAULT_CONFIG.WELFARE_ALLOWANCE, description: '員工福利津貼' }
  ]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // --- Barcode toggle state ---
  const [barcodeEnabled, setBarcodeEnabled] = useState(true);
  const [confirmDisableBarcode, setConfirmDisableBarcode] = useState(false);
  const [isBarcodeToggling, setIsBarcodeToggling] = useState(false);

  // --- Holiday form state ---
  const [newHolidayDate, setNewHolidayDate] = useState<string>('');
  const [newHolidayDescription, setNewHolidayDescription] = useState<string>('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [holidayType, setHolidayType] = useState<
    'worked' | 'sick_leave' | 'personal_leave' | 'national_holiday' | 'typhoon_leave' | 'special_leave'
  >('national_holiday');

  // --- Auth / PIN state ---
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [showChangePin, setShowChangePin] = useState(false);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [isChangingPin, setIsChangingPin] = useState(false);

  // --- Database status state ---
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected' | 'testing'>('testing');
  const [databaseModeLabel, setDatabaseModeLabel] = useState<string>('外部 PostgreSQL');
  const [databaseModeDescription, setDatabaseModeDescription] = useState<string>(
    '資料庫由伺服器端 DATABASE_URL 指向，與 Zeabur 應用容器生命週期分離。'
  );
  const [databaseConnectionHint, setDatabaseConnectionHint] = useState<string>(
    '實際連線目標由伺服器端 DATABASE_URL 管理，前端不提供資料源切換。'
  );

  // Initialize form from loaded settings
  useEffect(() => {
    if (!isLoading && settings) {
      setBaseHourlyRate(settings.baseHourlyRate || DEFAULT_CONFIG.BASE_HOURLY_RATE);
      setBaseMonthSalary(settings.baseMonthSalary || DEFAULT_CONFIG.BASE_MONTH_SALARY);
      setOt1Multiplier(settings.ot1Multiplier || DEFAULT_CONFIG.OT1_MULTIPLIER);
      setOt2Multiplier(settings.ot2Multiplier || DEFAULT_CONFIG.OT2_MULTIPLIER);
      setDeductions(settings.deductions || DEFAULT_CONFIG.DEDUCTIONS);
      const loadedAllowances =
        settings.allowances && settings.allowances.length > 0
          ? settings.allowances
          : [{ name: '福利金', amount: settings.welfareAllowance || DEFAULT_CONFIG.WELFARE_ALLOWANCE, description: '員工福利津貼' }];
      setAllowances(loadedAllowances);
      setBarcodeEnabled(settings.barcodeEnabled !== false);
      setHasUnsavedChanges(false);
    }
  }, [isLoading, settings]);

  // Detect unsaved changes
  useEffect(() => {
    if (!isLoading && settings) {
      const hasChanges =
        baseHourlyRate !== settings.baseHourlyRate ||
        baseMonthSalary !== settings.baseMonthSalary ||
        ot1Multiplier !== settings.ot1Multiplier ||
        ot2Multiplier !== settings.ot2Multiplier ||
        JSON.stringify(deductions) !== JSON.stringify(settings.deductions) ||
        JSON.stringify(allowances) !== JSON.stringify(settings.allowances);
      setHasUnsavedChanges(hasChanges);
    }
  }, [baseHourlyRate, baseMonthSalary, ot1Multiplier, ot2Multiplier, deductions, allowances, settings, isLoading]);

  // Database status refresh
  const refreshDatabaseStatus = async (showToast = false) => {
    if (!isSuperAdmin) {
      setConnectionStatus('testing');
      return;
    }
    setConnectionStatus('testing');
    try {
      const response = await apiRequest('GET', '/api/db-status');
      const data = await response.json();
      const postgresConnected = Boolean(data.connections?.postgres);
      const provider = data.databaseProvider;
      setConnectionStatus(postgresConnected ? 'connected' : 'disconnected');
      setDatabaseModeLabel(provider?.label || '外部 PostgreSQL');
      setDatabaseModeDescription(
        provider?.description || '資料庫由伺服器端 DATABASE_URL 指向，與 Zeabur 應用容器生命週期分離。'
      );
      setDatabaseConnectionHint(
        provider?.isExternal
          ? '正式資料儲存在外部資料庫，不會因為 Zeabur 應用重建而遺失。'
          : '目前資料庫與部署環境綁定，若要做資料隔離請改用外部 DATABASE_URL。'
      );
      if (showToast) {
        toast({
          title: postgresConnected ? '資料庫連線正常' : '資料庫連線異常',
          description: postgresConnected
            ? '系統目前固定使用 PostgreSQL-only 模式。'
            : '無法連接到 PostgreSQL，請檢查 DATABASE_URL 與資料庫服務狀態。',
          variant: postgresConnected ? 'default' : 'destructive'
        });
      }
    } catch (error) {
      console.error('Database status refresh failed:', error);
      const isAuthorizationError =
        error instanceof Error &&
        (error.message.startsWith('401') || error.message.startsWith('403'));
      if (isAuthorizationError) {
        setConnectionStatus('testing');
        setDatabaseConnectionHint('管理員工作階段可能已過期，請重新登入後再檢查資料庫狀態。');
        if (showToast) {
          toast({
            title: '需要重新驗證管理員',
            description: '資料庫診斷需要有效的管理員工作階段，請重新登入後再試。',
            variant: 'destructive'
          });
        }
        return;
      }
      setConnectionStatus('disconnected');
      if (showToast) {
        toast({ title: '連線檢查失敗', description: '無法取得資料庫狀態，請稍後再試。', variant: 'destructive' });
      }
    }
  };

  useEffect(() => {
    if (!isSuperAdmin) {
      setConnectionStatus('testing');
      return;
    }
    void refreshDatabaseStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin]);

  // --- Salary handlers ---
  const handleSaveSettings = async () => {
    if (!isAdmin) return;
    const totalAllowances = allowances.reduce((sum, item) => sum + item.amount, 0);
    setIsSaving(true);
    try {
      await updateSettings({
        baseHourlyRate,
        baseMonthSalary,
        welfareAllowance: totalAllowances,
        ot1Multiplier,
        ot2Multiplier,
        deductions,
        allowances,
        barcodeEnabled
      });
      setHasUnsavedChanges(false);
      toast({ title: '設定已儲存', description: '系統設定已成功更新。' });
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast({ title: '儲存失敗', description: '設定更新失敗，請稍後再試。', variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddDeduction = () =>
    setDeductions([...deductions, { name: '新項目', amount: 0, description: '' }]);

  const handleUpdateDeduction = (index: number, field: string, value: string | number) => {
    const updated = [...deductions];
    updated[index] = { ...updated[index], [field]: value };
    setDeductions(updated);
  };

  const handleDeleteDeduction = (index: number) =>
    setDeductions(deductions.filter((_, i) => i !== index));

  const handleAddAllowance = () =>
    setAllowances([...allowances, { name: '新項目', amount: 0, description: '' }]);

  const handleUpdateAllowance = (index: number, field: string, value: string | number) => {
    const updated = [...allowances];
    updated[index] = { ...updated[index], [field]: value };
    setAllowances(updated);
  };

  const handleDeleteAllowance = (index: number) =>
    setAllowances(allowances.filter((_, i) => i !== index));

  // --- Barcode toggle handlers ---
  const handleDisableBarcode = async () => {
    setIsBarcodeToggling(true);
    try {
      const totalAllowances = allowances.reduce((sum, item) => sum + item.amount, 0);
      const response = await apiRequest('POST', '/api/settings', {
        baseHourlyRate,
        baseMonthSalary,
        welfareAllowance: totalAllowances,
        ot1Multiplier,
        ot2Multiplier,
        deductions,
        allowances,
        barcodeEnabled: false
      });
      const data = await response.json();
      setBarcodeEnabled(false);
      setConfirmDisableBarcode(false);
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/admin'] });
      queryClient.invalidateQueries({ queryKey: ['/api/employees/admin'] });
      const migrated = (data as any).migrationResult?.migrated ?? 0;
      toast({ title: '掃碼槍功能已停用', description: `${migrated} 位員工身分證已加密為 AES-256-GCM` });
    } catch (error) {
      console.error('Failed to disable barcode:', error);
      toast({ title: '操作失敗', description: '停用掃碼槍時發生錯誤，請稍後再試', variant: 'destructive' });
    } finally {
      setIsBarcodeToggling(false);
    }
  };

  const handleEnableBarcode = async () => {
    setIsBarcodeToggling(true);
    try {
      const totalAllowances = allowances.reduce((sum, item) => sum + item.amount, 0);
      await apiRequest('POST', '/api/settings', {
        baseHourlyRate,
        baseMonthSalary,
        welfareAllowance: totalAllowances,
        ot1Multiplier,
        ot2Multiplier,
        deductions,
        allowances,
        barcodeEnabled: true
      });
      setBarcodeEnabled(true);
      queryClient.invalidateQueries({ queryKey: ['/api/settings'] });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/admin'] });
      queryClient.invalidateQueries({ queryKey: ['/api/employees/admin'] });
      toast({ title: '掃碼槍功能已重新啟用' });
    } catch (error) {
      console.error('Failed to enable barcode:', error);
      toast({ title: '操作失敗', description: '啟用掃碼槍時發生錯誤，請稍後再試', variant: 'destructive' });
    } finally {
      setIsBarcodeToggling(false);
    }
  };

  // --- Holiday handlers ---
  const handleAddHoliday = async () => {
    if (!newHolidayDate) {
      toast({ title: '日期必填', description: '請選擇假日日期。', variant: 'destructive' });
      return;
    }
    if (!selectedEmployeeId) {
      toast({ title: '員工必選', description: '請選擇要新增假日的員工。', variant: 'destructive' });
      return;
    }
    try {
      const addedHoliday = await addHoliday({
        employeeId: selectedEmployeeId,
        date: newHolidayDate,
        name: newHolidayDescription || '假日',
        holidayType,
        description: newHolidayDescription || ''
      });
      if (addedHoliday) {
        await handleSaveSettings();
        const selectedEmployee = employees?.find((emp) => emp.id === selectedEmployeeId);
        toast({ title: '新增成功', description: `已為員工 ${selectedEmployee?.name} 新增假日並自動儲存` });
        setNewHolidayDate('');
        setNewHolidayDescription('');
        setSelectedEmployeeId(null);
        setHolidayType('national_holiday');
      }
    } catch (error) {
      console.error('Failed to add holiday:', error);
      toast({ title: '新增失敗', description: '無法新增假日，請稍後再試。', variant: 'destructive' });
    }
  };

  const handleDeleteHoliday = async (id: number) => {
    try {
      const success = await deleteHoliday(id);
      if (success) toast({ title: '刪除成功', description: '假日已成功刪除。' });
    } catch (error) {
      console.error('Failed to delete holiday:', error);
      toast({ title: '刪除失敗', description: '無法刪除假日，請稍後再試。', variant: 'destructive' });
    }
  };

  // --- Auth handlers ---
  const handleAdminAction = async () => {
    if (isAdmin) {
      await logout();
      setShowChangePin(false);
    } else {
      setIsLoginModalOpen(true);
    }
  };

  const handleChangePin = async () => {
    if (newPin !== confirmPin) {
      toast({ title: 'PIN碼不匹配', description: '新PIN碼與確認PIN碼不匹配，請重新輸入', variant: 'destructive' });
      return;
    }
    if (newPin.length !== 6 || !/^\d+$/.test(newPin)) {
      toast({ title: 'PIN碼格式錯誤', description: 'PIN碼必須為6位數字', variant: 'destructive' });
      return;
    }
    setIsChangingPin(true);
    try {
      const success = await updatePin(currentPin, newPin);
      if (success) {
        setCurrentPin('');
        setNewPin('');
        setConfirmPin('');
        setShowChangePin(false);
        toast({ title: 'PIN碼更新成功', description: '管理員PIN碼已成功更新' });
      }
    } finally {
      setIsChangingPin(false);
    }
  };

  return {
    // Admin auth
    isAdmin,
    isSuperAdmin,
    logout,
    isLoginModalOpen,
    setIsLoginModalOpen,
    showChangePin,
    setShowChangePin,
    currentPin,
    setCurrentPin,
    newPin,
    setNewPin,
    confirmPin,
    setConfirmPin,
    isChangingPin,
    handleAdminAction,
    handleChangePin,
    // Settings load state
    isLoading,
    // Salary form
    baseHourlyRate,
    setBaseHourlyRate,
    baseMonthSalary,
    setBaseMonthSalary,
    ot1Multiplier,
    setOt1Multiplier,
    ot2Multiplier,
    setOt2Multiplier,
    deductions,
    allowances,
    hasUnsavedChanges,
    isSaving,
    handleSaveSettings,
    handleAddDeduction,
    handleUpdateDeduction,
    handleDeleteDeduction,
    handleAddAllowance,
    handleUpdateAllowance,
    handleDeleteAllowance,
    // Barcode
    barcodeEnabled,
    confirmDisableBarcode,
    setConfirmDisableBarcode,
    isBarcodeToggling,
    handleDisableBarcode,
    handleEnableBarcode,
    // Holiday
    holidays,
    isHolidaysLoading,
    newHolidayDate,
    setNewHolidayDate,
    newHolidayDescription,
    setNewHolidayDescription,
    selectedEmployeeId,
    setSelectedEmployeeId,
    holidayType,
    setHolidayType,
    handleAddHoliday,
    handleDeleteHoliday,
    // Employees
    normalizedEmployees,
    // Database status
    connectionStatus,
    databaseModeLabel,
    databaseModeDescription,
    databaseConnectionHint,
    refreshDatabaseStatus,
  };
}
