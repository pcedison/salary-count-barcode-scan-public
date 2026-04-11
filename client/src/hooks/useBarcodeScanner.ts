import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useAdmin } from '@/hooks/useAdmin';
import { useToast } from '@/hooks/use-toast';
import { invalidateAttendanceQueries } from '@/lib/attendanceRecords';
import { debugLog } from '@/lib/debug';
import { eventBus, EventNames } from '@/lib/eventBus';
import { getCurrentTime } from '@/lib/utils';
import { updateEmployeeCache } from '@/utils/employeeCache';

export interface ScanResult {
  timestamp: string;
  success: boolean;
  employeeId?: number;
  employeeName?: string;
  employee?: {
    id: number;
    name: string;
    department?: string;
    idNumber?: string;
  };
  department?: string;
  attendance?: {
    id: number;
    date: string;
    clockIn: string;
    clockOut?: string;
    isHoliday?: boolean;
  };
  action?: 'clock-in' | 'clock-out';
  isClockIn?: boolean;
  statusMessage: string;
  message?: string;
  clockTime?: string;
}

export interface ScanSessionStatus {
  required: boolean;
  unlocked: boolean;
  expiresAt: string | null;
  authMode: 'none' | 'scan_session' | 'admin_session';
}

interface UnlockTokenResponse {
  success: boolean;
  token: string;
  expiresAt: string;
}

const STATUS_AUTO_CLEAR_DELAY_MS = 6000;
const KIOSK_CHALLENGE_STORAGE_KEY = 'barcode-kiosk-challenge';

function getOrCreateKioskChallenge(): string {
  if (typeof window === 'undefined') {
    return 'server-kiosk-challenge';
  }

  const existing = window.sessionStorage.getItem(KIOSK_CHALLENGE_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `kiosk-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  window.sessionStorage.setItem(KIOSK_CHALLENGE_STORAGE_KEY, generated);
  return generated;
}

function createErrorScanResult(message: string): ScanResult {
  return {
    timestamp: new Date().toISOString(),
    success: false,
    statusMessage: message,
  };
}

function createProcessingScanResult(): ScanResult {
  return {
    timestamp: new Date().toISOString(),
    success: true,
    statusMessage: '正在處理打卡，請稍候…',
  };
}

function isCompleteSuccessPayload(value: unknown): value is ScanResult {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Partial<ScanResult>;
  return typeof payload.success === 'boolean' && typeof payload.statusMessage === 'string';
}

async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function useBarcodeScanner() {
  const { toast } = useToast();
  const { isAdmin, verifyPin } = useAdmin();
  const queryClient = useQueryClient();

  const [idNumber, setIdNumber] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);
  const [currentTime, setCurrentTime] = useState(getCurrentTime());
  const [scanSession, setScanSession] = useState<ScanSessionStatus | null>(null);
  const [isScanSessionLoading, setIsScanSessionLoading] = useState(true);
  const [isUnlockDialogOpen, setIsUnlockDialogOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const statusClearTimerRef = useRef<NodeJS.Timeout | null>(null);
  const kioskChallengeRef = useRef(getOrCreateKioskChallenge());
  const hasScanAccess = Boolean(
    scanSession && (!scanSession.required || scanSession.unlocked || scanSession.authMode === 'admin_session')
  );

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(getCurrentTime()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshScanSession = useCallback(async () => {
    setIsScanSessionLoading(true);

    try {
      const response = await fetch('/api/scan/session', {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`Unable to load scan session: ${response.status}`);
      }

      const payload = await response.json() as ScanSessionStatus;
      setScanSession(payload);
      return payload;
    } catch (error) {
      console.error('Failed to load scan session:', error);
      setScanSession(null);
      return null;
    } finally {
      setIsScanSessionLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshScanSession();
  }, [refreshScanSession]);

  const requestUnlockToken = useCallback(async (): Promise<string | null> => {
    const response = await fetch('/api/scan/session/token', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kioskChallenge: kioskChallengeRef.current,
      }),
    });

    const payload = await parseJsonSafely<UnlockTokenResponse | { message?: string }>(response);
    if (!response.ok) {
      toast({
        title: '無法產生解鎖權杖',
        description: payload && 'message' in payload && payload.message
          ? payload.message
          : '請重新驗證管理員身分後再試一次。',
        variant: 'destructive',
      });
      return null;
    }

    return payload && 'token' in payload ? payload.token : null;
  }, [toast]);

  const unlockScanSession = useCallback(async (pin: string) => {
    try {
      let authenticated = isAdmin;
      if (!authenticated) {
        authenticated = await verifyPin(pin);
      }

      if (!authenticated) {
        return false;
      }

      const token = await requestUnlockToken();
      if (!token) {
        return false;
      }

      const response = await fetch('/api/scan/session/unlock', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          kioskChallenge: kioskChallengeRef.current,
        }),
      });

      const payload = await parseJsonSafely<ScanSessionStatus & { message?: string }>(response);
      if (!response.ok || !payload) {
        toast({
          title: '解鎖失敗',
          description: payload?.message || '無法解鎖條碼打卡。',
          variant: 'destructive',
        });
        return false;
      }

      setScanSession(payload);
      toast({
        title: '掃碼站已解鎖',
        description: '現在可以開始條碼打卡。',
      });
      return true;
    } catch (error) {
      console.error('Failed to unlock scan session:', error);
      toast({
        title: '解鎖失敗',
        description: '無法解鎖條碼打卡。',
        variant: 'destructive',
      });
      return false;
    }
  }, [isAdmin, requestUnlockToken, toast, verifyPin]);

  const lockScanSession = useCallback(async () => {
    try {
      const response = await fetch('/api/scan/session/lock', {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`Unable to lock scan session: ${response.status}`);
      }

      const payload = await response.json() as ScanSessionStatus;
      setScanSession(payload);
      toast({
        title: '掃碼站已上鎖',
        description: '再次打卡前需要重新解鎖。',
      });
    } catch (error) {
      console.error('Failed to lock scan session:', error);
      toast({
        title: '上鎖失敗',
        description: '無法鎖定條碼打卡。',
        variant: 'destructive',
      });
    }
  }, [toast]);

  useEffect(() => {
    const handleBarcodeSuccess = (payload: unknown) => {
      if (!isCompleteSuccessPayload(payload)) {
        return;
      }

      debugLog('Received barcode success event', payload);
      setLastScan(payload);
      invalidateAttendanceQueries(queryClient);
    };

    eventBus.on(EventNames.BARCODE_SUCCESS, handleBarcodeSuccess);
    return () => {
      eventBus.off(EventNames.BARCODE_SUCCESS, handleBarcodeSuccess);
    };
  }, [queryClient]);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }

    if (!lastScan) {
      return;
    }

    if (statusClearTimerRef.current) {
      clearTimeout(statusClearTimerRef.current);
      statusClearTimerRef.current = null;
    }

    statusClearTimerRef.current = setTimeout(() => {
      setLastScan(null);
    }, STATUS_AUTO_CLEAR_DELAY_MS);

    return () => {
      if (statusClearTimerRef.current) {
        clearTimeout(statusClearTimerRef.current);
        statusClearTimerRef.current = null;
      }
    };
  }, [lastScan]);

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();

    const trimmedIdNumber = idNumber.trim();
    if (!trimmedIdNumber || isSubmitting) {
      return;
    }

    if (scanSession?.required && !hasScanAccess) {
      setIsUnlockDialogOpen(true);
      return;
    }

    setIsSubmitting(true);
    setIdNumber('');
    setLastScan(createProcessingScanResult());

    try {
      const response = await fetch('/api/barcode-scan', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idNumber: trimmedIdNumber }),
      });

      if (response.status === 401 && response.headers.get('x-scan-session-required') === 'true') {
        await refreshScanSession();
        setLastScan(createErrorScanResult('掃碼站已上鎖，請先解鎖。'));
        setIsUnlockDialogOpen(true);
        return;
      }

      const payload = await parseJsonSafely<any>(response);
      if (!response.ok) {
        const message = payload?.message || payload?.error || '打卡失敗，請稍後再試。';
        setLastScan(createErrorScanResult(message));
        toast({
          title: '打卡失敗',
          description: message,
          variant: 'destructive',
        });
        return;
      }

      if (!payload?.employeeId || !payload?.employeeName) {
        const message = payload?.message || '系統未回傳完整的打卡結果。';
        setLastScan(createErrorScanResult(message));
        toast({
          title: '打卡失敗',
          description: message,
          variant: 'destructive',
        });
        return;
      }

      const isClockIn = typeof payload.isClockIn === 'boolean'
        ? payload.isClockIn
        : payload.action === 'clock-in';
      const action: 'clock-in' | 'clock-out' = isClockIn ? 'clock-in' : 'clock-out';
      const clockTime = payload.clockTime ||
        (action === 'clock-in' ? payload.attendance?.clockIn : payload.attendance?.clockOut) ||
        currentTime;
      const statusMessage = payload.message ||
        `${payload.employeeName} ${action === 'clock-in' ? '上班' : '下班'}打卡成功`;

      updateEmployeeCache({
        id: payload.employeeId,
        name: payload.employeeName,
        department: payload.department || '',
        idNumber: payload.idNumber || '',
      });

      const scanResult: ScanResult = {
        timestamp: payload.timestamp || new Date().toISOString(),
        success: true,
        employeeId: payload.employeeId,
        employeeName: payload.employeeName,
        employee: {
          id: payload.employeeId,
          name: payload.employeeName,
          department: payload.department || '',
          idNumber: payload.idNumber || '',
        },
        department: payload.department || '',
        attendance: payload.attendance,
        action,
        isClockIn,
        statusMessage,
        clockTime,
      };

      setLastScan(scanResult);
      eventBus.emit(EventNames.BARCODE_SCANNED, scanResult);
      eventBus.emit(EventNames.BARCODE_SUCCESS, scanResult);
      invalidateAttendanceQueries(queryClient);
    } catch (error) {
      console.error('Barcode scan request failed:', error);
      setLastScan(createErrorScanResult('系統連線失敗，請稍後再試。'));
      toast({
        title: '打卡失敗',
        description: '系統連線失敗，請稍後再試。',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
      inputRef.current?.focus();
    }
  }, [currentTime, hasScanAccess, idNumber, isSubmitting, queryClient, refreshScanSession, scanSession, toast]);

  return {
    idNumber,
    setIdNumber,
    isSubmitting,
    inputRef,
    handleSubmit,
    lastScan,
    scanSession,
    isScanSessionLoading,
    isUnlockDialogOpen,
    setIsUnlockDialogOpen,
    unlockScanSession,
    lockScanSession,
    currentTime,
    hasScanAccess,
  };
}
