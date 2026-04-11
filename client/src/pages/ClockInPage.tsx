import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, CheckCircle2, XCircle, LogIn, UserCheck } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import liff from '@line/liff';

type PageState =
  | 'loading'
  | 'line_not_configured'
  | 'login'
  | 'bind'
  | 'pending'
  | 'ready'
  | 'clocking'
  | 'success'
  | 'error';

interface LineTempData {
  lineUserId: string;
  lineDisplayName: string;
  linePictureUrl?: string;
}

interface ClockInResult {
  action: 'clock-in' | 'clock-out';
  employeeName: string;
  clockTime: string;
  department?: string;
}

const LIFF_ID = import.meta.env.VITE_LIFF_ID;

export default function ClockInPage() {
  const [state, setState] = useState<PageState>('loading');
  const [lineData, setLineData] = useState<LineTempData | null>(null);
  const [idNumber, setIdNumber] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  const [clockResult, setClockResult] = useState<ClockInResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  // 共用打卡邏輯（LIFF 自動觸發與手動按鈕都走這裡）
  const performClockIn = useCallback(async (userId: string) => {
    setState('clocking');
    try {
      const res = await apiRequest('POST', '/api/line/clock-in', { lineUserId: userId });
      const data = await res.json();
      if (data.success) {
        setClockResult({
          action: data.action,
          employeeName: data.employeeName,
          clockTime: data.clockTime,
          department: data.department
        });
        setState('success');
      } else {
        setErrorMessage(data.error ?? '打卡失敗，請再試一次');
        setState('error');
      }
    } catch (err: any) {
      setErrorMessage(err?.message ?? '打卡失敗，請再試一次');
      setState('error');
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // 1. 確認後端 LINE 功能是否啟用
        const configRes = await fetch('/api/line/config');
        const config = await configRes.json();
        if (!config.configured) {
          setState('line_not_configured');
          return;
        }

        // 2. LIFF 流程（掃 QR code 開啟時）
        if (LIFF_ID) {
          try {
            await liff.init({
              liffId: LIFF_ID,
              // Let LIFF handle login when the QR opens in LINE's in-app browser
              // or an external browser instead of forcing a custom redirect URI.
              withLoginOnExternalBrowser: true
            });

            if (!liff.isLoggedIn()) {
              liff.login();
              return;
            }

            const accessToken = liff.getAccessToken();
            if (accessToken) {
              const authRes = await apiRequest('POST', '/api/line/liff-auth', { accessToken });
              const authData = await authRes.json();

              if (authData.success) {
                const temp: LineTempData = {
                  lineUserId: authData.lineUserId,
                  lineDisplayName: authData.lineDisplayName,
                  linePictureUrl: authData.linePictureUrl
                };
                setLineData(temp);

                // liff-auth 已包含 bindingStatus，不需要再發第 2 個請求
                if (authData.bindingStatus === 'bound') {
                  setEmployeeName(authData.employeeName ?? '');
                  if (liff.isInClient()) {
                    // 在 LINE app 內掃碼開啟 → 直接自動打卡
                    await performClockIn(temp.lineUserId);
                  } else {
                    // 在外部瀏覽器開啟 LIFF → 顯示打卡按鈕（測試用）
                    setState('ready');
                  }
                } else if (authData.bindingStatus === 'pending') {
                  setState('pending');
                } else {
                  setState('bind');
                }
                return;
              }
            }
          } catch {
            // LIFF 初始化失敗，降回 OAuth 流程
          }
        }

        // 3. OAuth 流程（原有邏輯，相容舊版）
        const tempRes = await fetch('/api/line/temp-data');
        if (tempRes.ok) {
          const temp: LineTempData = await tempRes.json();
          setLineData(temp);

          const statusRes = await fetch(
            `/api/line/binding-status/${encodeURIComponent(temp.lineUserId)}`
          );
          const status = await statusRes.json();

          if (status.status === 'bound') {
            setEmployeeName(status.employeeName);
            setState('ready');
          } else if (status.status === 'pending') {
            setState('pending');
          } else {
            setState('bind');
          }
        } else {
          setState('login');
        }
      } catch {
        setState('login');
      }
    })();
  }, [performClockIn]);

  const handleBind = useCallback(async () => {
    if (!lineData || !idNumber.trim()) return;
    setState('loading');
    try {
      const res = await apiRequest('POST', '/api/line/bind', {
        lineUserId: lineData.lineUserId,
        lineDisplayName: lineData.lineDisplayName,
        linePictureUrl: lineData.linePictureUrl,
        idNumber: idNumber.trim()
      });
      const data = await res.json();
      if (data.status === 'pending') {
        setState('pending');
      } else {
        setErrorMessage(data.error ?? '綁定失敗，請再試一次');
        setState('error');
      }
    } catch (err: any) {
      setErrorMessage(err?.message ?? '綁定失敗，請再試一次');
      setState('error');
    }
  }, [lineData, idNumber]);

  const handleClockIn = useCallback(async () => {
    if (!lineData) return;
    await performClockIn(lineData.lineUserId);
  }, [lineData, performClockIn]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-green-100 flex items-center justify-center p-4">
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader className="text-center pb-2">
          <CardTitle className="text-xl text-green-700">員工打卡系統</CardTitle>
          <CardDescription>使用 LINE 帳號快速打卡</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">

          {/* Loading / 打卡處理中 */}
          {(state === 'loading' || state === 'clocking') && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="h-10 w-10 text-green-600 animate-spin" />
              <p className="text-gray-500 text-sm">
                {state === 'clocking' ? '打卡處理中...' : '載入中...'}
              </p>
            </div>
          )}

          {/* LINE 未設定 */}
          {state === 'line_not_configured' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <XCircle className="h-12 w-12 text-red-400" />
              <p className="text-gray-600 text-center text-sm">LINE 打卡功能尚未設定<br />請聯絡管理員</p>
            </div>
          )}

          {/* 登入（OAuth 降回流程） */}
          {state === 'login' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <p className="text-gray-600 text-sm text-center">請用您的 LINE 帳號登入打卡</p>
              <a href="/api/line/login" className="w-full">
                <Button className="w-full bg-[#06C755] hover:bg-[#05b34d] text-white gap-2">
                  <LogIn className="h-4 w-4" />
                  使用 LINE 登入
                </Button>
              </a>
            </div>
          )}

          {/* 綁定員工 ID */}
          {state === 'bind' && lineData && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                {lineData.linePictureUrl && (
                  <img
                    src={lineData.linePictureUrl}
                    alt="LINE 大頭照"
                    className="w-12 h-12 rounded-full border-2 border-green-200"
                  />
                )}
                <div>
                  <p className="font-medium text-gray-800">{lineData.lineDisplayName}</p>
                  <p className="text-xs text-gray-500">LINE 帳號</p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm text-gray-600">請輸入您的身分證字號或居留證號碼完成綁定：</p>
                <Input
                  placeholder="身分證字號（例：A123456789）"
                  value={idNumber}
                  onChange={e => setIdNumber(e.target.value.toUpperCase())}
                  className="font-mono"
                  maxLength={10}
                />
              </div>

              <Button
                className="w-full bg-[#06C755] hover:bg-[#05b34d] text-white"
                onClick={handleBind}
                disabled={idNumber.trim().length < 8}
              >
                <UserCheck className="h-4 w-4 mr-2" />
                確認綁定
              </Button>
              <p className="text-xs text-gray-400 text-center">
                提交後需等待管理員審核，審核通過即可打卡
              </p>
            </div>
          )}

          {/* 等待審核 */}
          {state === 'pending' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <div className="w-16 h-16 rounded-full bg-yellow-100 flex items-center justify-center">
                <span className="text-3xl">⏳</span>
              </div>
              <p className="font-medium text-gray-700">申請審核中</p>
              <p className="text-sm text-gray-500 text-center">
                您的綁定申請已送出，請等待管理員審核。<br />
                審核通過後即可使用 LINE 打卡。
              </p>
            </div>
          )}

          {/* 準備打卡（外部瀏覽器測試用） */}
          {state === 'ready' && lineData && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3 p-3 bg-green-50 rounded-lg">
                {lineData.linePictureUrl && (
                  <img
                    src={lineData.linePictureUrl}
                    alt="LINE 大頭照"
                    className="w-12 h-12 rounded-full border-2 border-green-200"
                  />
                )}
                <div>
                  <p className="font-medium text-gray-800">{employeeName}</p>
                  <p className="text-xs text-gray-500">{lineData.lineDisplayName}</p>
                </div>
              </div>

              <Button
                className="w-full bg-[#06C755] hover:bg-[#05b34d] text-white h-14 text-lg"
                onClick={handleClockIn}
              >
                確認打卡
              </Button>
              <p className="text-xs text-gray-400 text-center">
                系統將自動判斷上班或下班打卡
              </p>
            </div>
          )}

          {/* 打卡成功 */}
          {state === 'success' && clockResult && (
            <div className="flex flex-col items-center gap-3 py-4">
              <CheckCircle2 className="h-16 w-16 text-green-500" />
              <p className="text-xl font-bold text-green-700">
                {clockResult.action === 'clock-in' ? '上班打卡成功！' : '下班打卡成功！'}
              </p>
              <div className="text-center space-y-1">
                <p className="text-gray-700 font-medium">{clockResult.employeeName}</p>
                {clockResult.department && (
                  <p className="text-gray-500 text-sm">{clockResult.department}</p>
                )}
                <p className="text-2xl font-mono font-bold text-gray-800 mt-2">
                  {clockResult.clockTime}
                </p>
              </div>
              <p className="text-xs text-gray-400">打卡結果已透過 LINE 通知您</p>
            </div>
          )}

          {/* 錯誤 */}
          {state === 'error' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <XCircle className="h-12 w-12 text-red-400" />
              <p className="text-gray-600 text-center text-sm">{errorMessage || '發生錯誤，請再試一次'}</p>
              <Button
                variant="outline"
                className="mt-2"
                onClick={() => {
                  setErrorMessage('');
                  setState('login');
                }}
              >
                重新開始
              </Button>
            </div>
          )}

        </CardContent>
      </Card>
    </div>
  );
}
