import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, CheckCircle2, XCircle, LogIn, UserCheck } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import liff from '@line/liff';
import { clockJournalKey, readClockAttempt, saveClockAttempt, newClockAttempt,
  canResendClockAttempt, clockRequest, clockAttemptBody, ClockRequestError,
  clockTimeAnchor, clockTimeFromAnchor, withClockJournalLock, finishClockAttempt,
  type ClockState, type ClockAttempt, type ClockTimeAnchor } from '@/lib/lineClockJournal';

type PageState =
  | 'loading'
  | 'line_not_configured'
  | 'login'
  | 'bind'
  | 'pending'
  | 'ready'
  | 'clocking'
  | 'unconfirmed'
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
  const [clockState, setClockState] = useState<ClockState | null>(null);
  const [canPrepareNext, setCanPrepareNext] = useState(false);
  const clockBusy = useRef(false);
  const activeUser = useRef<string | null>(null);
  const activeJournalKey = useRef<string | null>(null);
  const timeAnchor = useRef<ClockTimeAnchor | null>(null);

  const showReceipt = useCallback(async (key: string, attempt: ClockAttempt, data: ClockInResult) => {
    if (activeJournalKey.current !== key) return;
    setClockResult(data);
    try {
      const current = await withClockJournalLock(key, () => finishClockAttempt(localStorage, key, attempt, 'confirmed'));
      if (activeJournalKey.current !== key) return;
      if (!current) {
        setCanPrepareNext(false);
        setErrorMessage('另一個頁面已有較新的打卡。請先核對原次結果，不會以舊回應覆蓋紀錄。');
        setState('unconfirmed');
        return;
      }
      setErrorMessage('');
      setCanPrepareNext(true);
    } catch {
      if (activeJournalKey.current !== key) return;
      setErrorMessage('打卡已記錄，但手機無法保存確認狀態。請保留此頁並聯絡管理員，勿重複打卡。');
      setCanPrepareNext(false);
    }
    setState('success');
  }, []);

  const sendOriginal = useCallback(async (key: string, attempt: ClockAttempt) => {
    if (activeJournalKey.current !== key || !activeUser.current) return;
    const intendedUser = activeUser.current;
    try {
      const data = await clockRequest<ClockInResult>('/api/line/clock-in', {
        ...clockAttemptBody(attempt), lineUserId: intendedUser,
      });
      await showReceipt(key, attempt, data);
    } catch (error) {
      // Only an explicit rejection known to occur before the transaction writes
      // allows a fresh action. Network/auth/server errors remain unresolved.
      const rejected = error instanceof ClockRequestError && [
        'LINE_CLOCK_STATE_CONFLICT', 'LINE_CLOCK_TIMESTAMP_INVALID', 'LINE_CLOCK_TIMESTAMP_EXPIRED',
        'LINE_CLOCK_TIME_CONFLICT',
      ].includes(error.code);
      const stillCurrent = rejected
        ? await withClockJournalLock(key, () => finishClockAttempt(localStorage, key, attempt, 'rejected')) : false;
      if (activeJournalKey.current !== key) return;
      setCanPrepareNext(rejected && stillCurrent);
      setErrorMessage(rejected && stillCurrent ? '這次打卡未寫入：狀態或時間已變更。請核對最新狀態後再確認。'
        : '尚未確認這次打卡結果。請先確認原次結果，勿重新建立打卡；登入到期時請重新登入。');
      setState(rejected && stillCurrent ? 'error' : 'unconfirmed');
    }
  }, [showReceipt]);

  const recoverOriginal = useCallback(async (userId: string, resend = false): Promise<boolean> => {
    const key = await clockJournalKey(userId);
    if (activeUser.current !== userId) return true;
    activeJournalKey.current = key;
    const attempt = readClockAttempt(localStorage, key);
    if (!attempt) return false;
    if (attempt.phase === 'rejected') {
      setCanPrepareNext(true);
      setErrorMessage('前次打卡未寫入。請核對最新狀態後再確認。');
      setState('error');
      return true;
    }
    try {
      const receipt = await clockRequest<ClockInResult>(`/api/line/clock-in/requests/${attempt.eventId}?lineUserId=${encodeURIComponent(userId)}`);
      await showReceipt(key, attempt, receipt);
    } catch (error) {
      if (activeJournalKey.current !== key) return true;
      if (error instanceof ClockRequestError && error.status === 404 && resend && attempt.phase === 'pending') {
        // Consult server time, not a potentially fast/slow phone wall clock.
        const current = await clockRequest<ClockState>(`/api/line/clock-in/state?lineUserId=${encodeURIComponent(userId)}`);
        if (activeJournalKey.current !== key) return true;
        if (canResendClockAttempt(attempt, clockTimeAnchor(current).serverMs)) {
          await sendOriginal(key, attempt);
          return true;
        }
      }
      setCanPrepareNext(false);
      setErrorMessage('上次打卡尚待核對。請確認原次結果；若超過五分鐘或仍無法確認，請聯絡管理員，不會以現在時間補打。');
      setState('unconfirmed');
    }
    return true;
  }, [showReceipt, sendOriginal]);

  const prepareClockIn = useCallback(async (userId: string, next = false) => {
    setState('loading');
    setErrorMessage('');
    setCanPrepareNext(false);
    timeAnchor.current = null;
    try {
      const key = await clockJournalKey(userId);
      if (activeUser.current !== userId) return;
      activeJournalKey.current = key;
      const saved = readClockAttempt(localStorage, key);
      if ((!next || saved?.phase === 'pending') && await recoverOriginal(userId)) return;
      const current = await clockRequest<ClockState>(`/api/line/clock-in/state?lineUserId=${encodeURIComponent(userId)}`);
      if (activeUser.current !== userId) return;
      timeAnchor.current = clockTimeAnchor(current);
      setClockState(current);
      setState('ready');
    } catch (error) {
      if (activeUser.current !== userId) return;
      setErrorMessage(error instanceof Error ? error.message : '無法取得打卡狀態，尚未送出');
      setState('error');
    }
  }, [recoverOriginal]);

  const performClockIn = useCallback(async (userId: string) => {
    if (clockBusy.current || !clockState || !timeAnchor.current) return;
    clockBusy.current = true;
    setState('clocking');
    try {
      const key = await clockJournalKey(userId);
      if (activeUser.current !== userId) return;
      const reserved = await withClockJournalLock(key, () => {
        if (activeUser.current !== userId || !timeAnchor.current) return null;
        const previous = readClockAttempt(localStorage, key);
        if (previous?.phase === 'pending') return { existing: true, attempt: previous };
        const attempt = newClockAttempt(clockState, clockTimeFromAnchor(timeAnchor.current));
        saveClockAttempt(localStorage, key, attempt); // Must succeed before any write.
        return { existing: false, attempt };
      });
      if (!reserved) return;
      if (reserved.existing) { await recoverOriginal(userId, true); return; }
      await sendOriginal(key, reserved.attempt);
    } catch (err) {
      if (activeUser.current !== userId) return;
      setErrorMessage(err instanceof Error ? err.message : '無法確認打卡結果，請保留此頁並聯絡管理員');
      setState('error');
      setCanPrepareNext(false);
    } finally { clockBusy.current = false; }
  }, [clockState, recoverOriginal, sendOriginal]);

  // LINE 可能從 bfcache 恢復舊頁面。重載僅重新確認登入與原回執，
  // 不自動建立打卡；新的上下班動作仍須明確確認。
  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        window.location.reload();
      }
    };
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. 確認後端 LINE 功能是否啟用
        // 刻意用裸 fetch:LIFF 公開端點,非 2xx 走優雅分支而非拋錯。
        const configRes = await fetch('/api/line/config');
        const config = await configRes.json();
        if (cancelled) return;
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
            if (cancelled) return;

            if (!liff.isLoggedIn()) {
              liff.login();
              return;
            }

            const accessToken = liff.getAccessToken();
            if (accessToken) {
              const authRes = await apiRequest('POST', '/api/line/liff-auth', { accessToken });
              const authData = await authRes.json();

              if (authData.success) {
                if (cancelled) return;
                const temp: LineTempData = {
                  lineUserId: authData.lineUserId,
                  lineDisplayName: authData.lineDisplayName,
                  linePictureUrl: authData.linePictureUrl
                };
                setLineData(temp);
                activeUser.current = temp.lineUserId;

                // liff-auth 已包含 bindingStatus，不需要再發第 2 個請求
                if (authData.bindingStatus === 'bound') {
                  setEmployeeName(authData.employeeName ?? '');
                  // A fixed QR URL cannot distinguish a fresh scan from a reload.
                  // Restore the receipt first; a new punch always requires a tap.
                  await prepareClockIn(temp.lineUserId);
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
            if (cancelled) return;
          }
        }

        // 3. OAuth 流程（原有邏輯，相容舊版）
        const tempRes = await fetch('/api/line/temp-data');
        if (tempRes.ok) {
          const temp: LineTempData = await tempRes.json();
          if (cancelled) return;
          setLineData(temp);
          activeUser.current = temp.lineUserId;

          const statusRes = await fetch(
            `/api/line/binding-status/${encodeURIComponent(temp.lineUserId)}`
          );
          const status = await statusRes.json();
          if (cancelled) return;

          if (status.status === 'bound') {
            setEmployeeName(status.employeeName);
            await prepareClockIn(temp.lineUserId);
          } else if (status.status === 'pending') {
            setState('pending');
          } else {
            setState('bind');
          }
        } else {
          if (!cancelled) setState('login');
        }
      } catch {
        if (!cancelled) setState('login');
      }
    })();
    return () => { cancelled = true; activeUser.current = null; activeJournalKey.current = null; };
  }, [prepareClockIn]);

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
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '綁定失敗，請再試一次');
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
                {state === 'clocking' ? '正在確認打卡，請勿重複操作...' : '載入中...'}
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

          {/* LINE 與一般瀏覽器皆顯示明確動作後再寫入 */}
          {state === 'ready' && lineData && clockState && (
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
                {clockState.action === 'clock-in' ? '確認上班打卡' : '確認下班打卡'}
              </Button>
              <p className="text-xs text-gray-400 text-center">
                請核對上方動作，按下確認後才會記錄時間
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
              <p className="text-xs text-gray-500">出勤已記錄。LINE 通知可能稍後送達。</p>
              {errorMessage && <p role="alert" className="text-sm text-amber-800 text-center break-words">{errorMessage}</p>}
              {canPrepareNext && lineData && <Button variant="outline" onClick={() => prepareClockIn(lineData.lineUserId, true)}>
                準備下一次打卡
              </Button>}
            </div>
          )}

          {/* 錯誤 */}
          {(state === 'error' || state === 'unconfirmed') && (
            <div className="flex flex-col items-center gap-3 py-6">
              <XCircle className="h-12 w-12 text-red-400" />
              <p role="alert" className="text-gray-600 text-center text-sm break-words">{errorMessage || '無法確認，請聯絡管理員'}</p>
              {state === 'unconfirmed' && lineData && <Button variant="outline" onClick={async () => {
                if (clockBusy.current) return;
                clockBusy.current = true;
                setState('clocking');
                try { await recoverOriginal(lineData.lineUserId, true); }
                catch (error) { setErrorMessage(error instanceof Error ? error.message : '無法確認原次結果'); setState('unconfirmed'); }
                finally { clockBusy.current = false; }
              }}>確認原次打卡結果</Button>}
              {canPrepareNext && lineData && <Button variant="outline" onClick={() => prepareClockIn(lineData.lineUserId, true)}>
                核對最新打卡狀態
              </Button>}
              <a href="/api/line/login" className="text-sm text-green-800 underline">重新登入並核對原次結果</a>
            </div>
          )}

        </CardContent>
      </Card>
    </div>
  );
}
