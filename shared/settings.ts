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

export interface PublicSettingsPayload {
  baseHourlyRate: number;
  ot1Multiplier: number;
  ot2Multiplier: number;
  baseMonthSalary: number;
  welfareAllowance: number;
  barcodeEnabled: boolean;
}

export interface AdminSettingsPayload extends PublicSettingsPayload {
  deductions: DeductionItem[];
  allowances: AllowanceItem[];
}

type SettingsLike = Partial<Omit<AdminSettingsPayload, "deductions" | "allowances" | "barcodeEnabled">> & {
  deductions?: DeductionItem[] | null;
  allowances?: AllowanceItem[] | null;
  barcodeEnabled?: boolean | null;
};

export const DEFAULT_PUBLIC_SETTINGS: PublicSettingsPayload = {
  baseHourlyRate: 119,
  ot1Multiplier: 1.34,
  ot2Multiplier: 1.67,
  baseMonthSalary: 28590,
  welfareAllowance: 0,
  barcodeEnabled: true,
};

export const DEFAULT_ADMIN_SETTINGS: AdminSettingsPayload = {
  ...DEFAULT_PUBLIC_SETTINGS,
  deductions: [],
  allowances: [],
};

export function toPublicSettingsPayload(
  settings?: SettingsLike | null,
): PublicSettingsPayload {
  return {
    ...DEFAULT_PUBLIC_SETTINGS,
    baseHourlyRate: settings?.baseHourlyRate ?? DEFAULT_PUBLIC_SETTINGS.baseHourlyRate,
    ot1Multiplier: settings?.ot1Multiplier ?? DEFAULT_PUBLIC_SETTINGS.ot1Multiplier,
    ot2Multiplier: settings?.ot2Multiplier ?? DEFAULT_PUBLIC_SETTINGS.ot2Multiplier,
    baseMonthSalary: settings?.baseMonthSalary ?? DEFAULT_PUBLIC_SETTINGS.baseMonthSalary,
    welfareAllowance: settings?.welfareAllowance ?? DEFAULT_PUBLIC_SETTINGS.welfareAllowance,
    barcodeEnabled: settings?.barcodeEnabled ?? DEFAULT_PUBLIC_SETTINGS.barcodeEnabled,
  };
}

export function toAdminSettingsPayload(
  settings?: SettingsLike | null,
): AdminSettingsPayload {
  return {
    ...toPublicSettingsPayload(settings),
    deductions: Array.isArray(settings?.deductions) ? settings.deductions : [],
    allowances: Array.isArray(settings?.allowances) ? settings.allowances : [],
  };
}
