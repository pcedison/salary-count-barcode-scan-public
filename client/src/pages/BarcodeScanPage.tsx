import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Loader2,
  Lock,
  ShieldAlert,
  UserCheck,
  XCircle,
} from 'lucide-react';

import AdminLoginDialog from '@/components/AdminLoginDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { getQueryFn } from '@/lib/queryClient';
import { getTodayDate } from '@/lib/utils';

type PublicAttendanceRecord = {
  id: number;
  employeeName: string;
  department: string | null;
  date: string;
  clockIn: string;
  clockOut?: string | null;
  isBarcodeScanned?: boolean;
};

type TimelineRecord = {
  key: string;
  employeeName: string;
  department: string | null;
  action: 'clock-in' | 'clock-out';
  time: string;
};

function buildTimeline(records: PublicAttendanceRecord[]): TimelineRecord[] {
  const timeline = records.flatMap((record) => {
    const base = {
      employeeName: record.employeeName,
      department: record.department,
    };

    const items: TimelineRecord[] = [
      {
        key: `${record.id}-in`,
        ...base,
        action: 'clock-in',
        time: record.clockIn,
      },
    ];

    if (record.clockOut) {
      items.push({
        key: `${record.id}-out`,
        ...base,
        action: 'clock-out',
        time: record.clockOut,
      });
    }

    return items;
  });

  return timeline.sort((left, right) => right.time.localeCompare(left.time));
}

export default function BarcodeScanPage() {
  const {
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
  } = useBarcodeScanner();

  const { data: todayAttendanceRecords = null } = useQuery<PublicAttendanceRecord[] | null>({
    queryKey: ['/api/attendance/today'],
    queryFn: getQueryFn<PublicAttendanceRecord[] | null>({ on401: 'returnNull' }),
    enabled: hasScanAccess,
    refetchInterval: 30_000,
    staleTime: 25_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const todayDate = getTodayDate();

  const todayRecords = useMemo(() => {
    return (Array.isArray(todayAttendanceRecords) ? todayAttendanceRecords : [])
      .filter((record) => record.date === todayDate)
      .filter((record) => record.isBarcodeScanned !== false);
  }, [todayAttendanceRecords, todayDate]);

  const incompleteRecords = useMemo(() => {
    return todayRecords.filter((record) => !record.clockOut);
  }, [todayRecords]);

  const timelineRecords = useMemo(() => buildTimeline(todayRecords), [todayRecords]);

  return (
    <div className="container mx-auto space-y-6 p-4">
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="min-w-0 flex-1">
          <Card className="h-full">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xl font-bold">員工打卡</CardTitle>
                <div className="text-right">
                  <p className="font-mono text-2xl">{currentTime}</p>
                  <p className="text-sm text-muted-foreground">{todayDate}</p>
                </div>
              </div>
              <CardDescription>請使用條碼掃描槍或輸入員工證號進行打卡。</CardDescription>
            </CardHeader>

            <CardContent className="space-y-6 pb-2">
              {isScanSessionLoading ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
                  正在確認掃碼站狀態…
                </div>
              ) : scanSession?.required && !hasScanAccess ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-4">
                  <div className="flex items-start gap-3">
                    <ShieldAlert className="mt-0.5 h-5 w-5 text-amber-700" />
                    <div className="flex-1">
                      <p className="font-medium text-amber-900">掃碼站目前已上鎖</p>
                      <p className="mt-1 text-sm text-amber-800">
                        請由管理員驗證後解鎖，才能開始條碼打卡。
                      </p>
                    </div>
                    <Button type="button" variant="outline" onClick={() => setIsUnlockDialogOpen(true)}>
                      <Lock className="mr-2 h-4 w-4" />
                      解鎖
                    </Button>
                  </div>
                </div>
              ) : scanSession?.required ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      掃碼站已解鎖
                      {scanSession.expiresAt ? `，有效至 ${new Date(scanSession.expiresAt).toLocaleString()}` : ''}
                    </div>
                    {scanSession.authMode === 'scan_session' && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => void lockScanSession()}>
                        立即上鎖
                      </Button>
                    )}
                  </div>
                </div>
              ) : null}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Input
                      ref={inputRef}
                      type="text"
                      placeholder="請掃描條碼或輸入證號…"
                      className="h-12 text-lg"
                      value={idNumber}
                      onChange={(event) => setIdNumber(event.target.value)}
                      disabled={isSubmitting || Boolean(scanSession?.required && !hasScanAccess)}
                      autoComplete="off"
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={isSubmitting || !idNumber.trim() || Boolean(scanSession?.required && !hasScanAccess)}
                    className="h-12"
                  >
                    {isSubmitting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
                    打卡
                  </Button>
                </div>
              </form>

              {lastScan && (
                <Card className={lastScan.success ? 'bg-primary/5' : 'bg-destructive/5'}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      <div className={lastScan.success ? 'rounded-full bg-primary/10 p-2 text-primary' : 'rounded-full bg-destructive/10 p-2 text-destructive'}>
                        {lastScan.success ? <CheckCircle2 size={28} /> : <XCircle size={28} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="line-clamp-1 text-xl font-semibold">{lastScan.statusMessage}</h3>
                        {lastScan.success && lastScan.employeeName ? (
                          <>
                            <p className="text-sm text-muted-foreground">
                              {lastScan.action === 'clock-out' ? '下班' : '上班'}時間 {lastScan.clockTime || ''}
                            </p>
                            {lastScan.employee?.department ? (
                              <p className="text-sm text-muted-foreground">{lastScan.employee.department}</p>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {incompleteRecords.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">仍在上班中的員工 ({incompleteRecords.length})</h3>
                  <div className="space-y-1">
                    {incompleteRecords.map((record) => (
                      <Card key={record.id} className="bg-amber-50 dark:bg-amber-950/20">
                        <CardContent className="p-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <UserCheck className="h-5 w-5 text-amber-600" />
                              <div>
                                <p className="font-medium">{record.employeeName}</p>
                                <p className="text-xs text-muted-foreground">{record.department || '未設定部門'}</p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p>{record.clockIn}</p>
                              <p className="text-xs text-muted-foreground">上班時間</p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="md:w-96">
          <Card className="h-full">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarDays className="h-4 w-4" />
                今日打卡紀錄
                <span className="text-sm font-normal text-muted-foreground">({todayRecords.length})</span>
              </CardTitle>
            </CardHeader>

            <CardContent className="pb-2">
              {timelineRecords.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground">今日尚無打卡紀錄。</div>
              ) : (
                <div className="max-h-[calc(100vh-26rem)] space-y-1.5 overflow-y-auto pr-1">
                  {timelineRecords.map((record) => (
                    <Card key={record.key} className="bg-muted/30">
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {record.action === 'clock-in' ? (
                              <UserCheck className="h-4 w-4 text-green-500" />
                            ) : (
                              <Clock className="h-4 w-4 text-blue-500" />
                            )}
                            <div>
                              <p className="font-medium">{record.employeeName}</p>
                              <p className="text-xs text-muted-foreground">{record.department || '未設定部門'}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p>{record.time}</p>
                            <p className="text-xs text-muted-foreground">
                              {record.action === 'clock-in' ? '上班時間' : '下班時間'}
                            </p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <AdminLoginDialog
        isOpen={isUnlockDialogOpen}
        onClose={() => setIsUnlockDialogOpen(false)}
        onVerifyPin={unlockScanSession}
        title="解鎖掃碼站"
        description="請由管理員驗證身分後解鎖條碼打卡。"
        pinLabel="管理員 PIN"
        placeholder="請輸入 6 碼 PIN"
        submitLabel="解鎖"
        verifyingLabel="驗證中…"
      />
    </div>
  );
}
