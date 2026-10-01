import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiRequest } from '@/lib/queryClient';
import { formatCurrency } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
  correctionErrorMessage, correctionMonthBounds, holidayTypeLabels,
  normalizeSnapshotDate, paymentHandlingLabels, validateHolidayCorrection,
  type CorrectionSalaryRecord, type HolidayCorrectionEntry, type HolidayCorrectionInput,
  type HolidayCorrectionPreview, type HolidayCorrectionRequest, type PaymentHandling,
} from '@/lib/holidayCorrection';

interface Props {
  recordId: number;
  onClose: () => void;
  onSaved: () => void;
}
const newHoliday = (): HolidayCorrectionInput => ({ date: '', holidayType: 'national_holiday', name: '國定假日', mode: 'add' });
const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

export default function HolidayCorrectionModal({ recordId, onClose, onSaved }: Props) {
  const { toast } = useToast();
  const [record, setRecord] = useState<CorrectionSalaryRecord | null>(null);
  const [corrections, setCorrections] = useState<HolidayCorrectionEntry[]>([]);
  const [holidays, setHolidays] = useState<HolidayCorrectionInput[]>([newHoliday()]);
  const [reason, setReason] = useState('');
  const [paymentHandling, setPaymentHandling] = useState<PaymentHandling | ''>('');
  const [preview, setPreview] = useState<HolidayCorrectionPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const saveRequest = useRef<{ request: HolidayCorrectionRequest; idempotencyKey: string } | null>(null);
  const stepTitle = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setPreview(null);
    saveRequest.current = null;
    try {
      const [recordResponse, historyResponse] = await Promise.all([
        apiRequest('GET', `/api/salary-records/${recordId}`),
        apiRequest('GET', `/api/salary-records/${recordId}/holiday-corrections`),
      ]);
      const freshRecord = await recordResponse.json();
      const history = await historyResponse.json();
      if (!mounted.current) return;
      setRecord(freshRecord);
      setCorrections(history.corrections ?? []);
      setConflict(false);
    } catch (err) {
      if (mounted.current) setError(correctionErrorMessage(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [recordId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);
  useEffect(() => { if (preview) stepTitle.current?.focus(); }, [preview]);

  const updateHoliday = (index: number, patch: Partial<HolidayCorrectionInput>) => {
    setHolidays((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
    setError('');
  };
  const requestPreview = async () => {
    if (inFlight.current || !record) return;
    const validation = validateHolidayCorrection(record, holidays, reason, paymentHandling);
    if (validation) { setError(validation); return; }
    const request: HolidayCorrectionRequest = {
      revision: record.revision,
      holidays: holidays.map((holiday) => ({ ...holiday, name: holiday.name.trim() })),
      reason: reason.trim(),
      paymentHandling: paymentHandling as PaymentHandling,
    };
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await apiRequest('POST', `/api/salary-records/${recordId}/holiday-corrections/preview`, request);
      const result: HolidayCorrectionPreview = await response.json();
      if (!mounted.current) return;
      saveRequest.current = { request, idempotencyKey: crypto.randomUUID() };
      setPreview(result);
      setConfirmed(false);
    } catch (err) {
      if (mounted.current) {
        setError(correctionErrorMessage(err));
        setConflict(err instanceof Error && err.message.startsWith('409:'));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const save = async () => {
    if (inFlight.current || !preview || !saveRequest.current || !confirmed) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const { request, idempotencyKey } = saveRequest.current;
      await apiRequest('POST', `/api/salary-records/${recordId}/holiday-corrections`, {
        ...request, previewToken: preview.previewToken, idempotencyKey,
      });
      if (!mounted.current) return;
      toast({ title: '更正已保存', description: '歷史薪資與更正紀錄已更新。系統未付款或通知員工。' });
      onSaved();
      onClose();
    } catch (err) {
      if (mounted.current) {
        setError(correctionErrorMessage(err));
        if (err instanceof Error && err.message.startsWith('409:')) {
          setConflict(true);
          setPreview(null);
          saveRequest.current = null;
        }
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const bounds = record ? correctionMonthBounds(record) : null;
  const comparisonRows = preview ? [
    ['總薪資', preview.before.grossSalary, preview.after.grossSalary, preview.delta.grossSalary],
    ['扣款合計', preview.before.totalDeductions, preview.after.totalDeductions, preview.delta.totalDeductions],
    ['應付薪資', preview.before.netSalary, preview.after.netSalary, preview.delta.netSalary],
    ['假日加給', preview.before.totalHolidayPay, preview.after.totalHolidayPay, preview.delta.totalHolidayPay],
  ] as const : [];

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !inFlight.current) onClose(); }}>
      <DialogContent className="max-w-5xl w-[calc(100%-1rem)] max-h-[90dvh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>歷史薪資假日更正</DialogTitle>
          <DialogDescription>
            {record ? `${record.employeeName || `員工 #${record.employeeId ?? '未指定'}`} · ${record.salaryYear} 年 ${record.salaryMonth} 月 · 修訂 ${record.revision}` : '正在讀取最新結算紀錄'}
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">本流程保存結算更正與差額紀錄，不會付款或通知員工。已發薪或狀態待核對時，差額需由管理員另外核對及處理。</p>
        {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
        {conflict && <Button type="button" variant="outline" disabled={busy} onClick={() => void load()}>重新讀取最新紀錄</Button>}
        {busy && !record && <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />讀取中…</p>}
        {!busy && !record && <Button type="button" onClick={() => void load()}>重新讀取</Button>}
        {record && <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="min-w-0 space-y-4">
            {preview ? <>
              <h3 ref={stepTitle} tabIndex={-1} className="font-semibold outline-none">核對預覽</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <caption className="sr-only">薪資更正前後金額與差額</caption>
                  <thead><tr className="border-b"><th scope="col" className="p-2 text-left">項目</th><th scope="col" className="p-2 text-right">更正前</th><th scope="col" className="p-2 text-right">更正後</th><th scope="col" className="p-2 text-right">差額</th></tr></thead>
                  <tbody>{comparisonRows.map(([label, before, after, delta]) => <tr className="border-b" key={label}><th scope="row" className="p-2 text-left font-medium">{label}</th><td className="p-2 text-right">{formatCurrency(before)}</td><td className="p-2 text-right">{formatCurrency(after)}</td><td className="p-2 text-right font-semibold">{delta > 0 ? '+' : ''}{formatCurrency(delta)}</td></tr>)}</tbody>
                </table>
              </div>
              <p className="text-sm">假日出勤天數：{preview.before.holidayDays} → {preview.after.holidayDays}（差額 {preview.delta.holidayDays > 0 ? '+' : ''}{preview.delta.holidayDays}）</p>
              <p className="rounded-md bg-muted p-3 text-sm">{preview.calculationNote || '依此結算紀錄的薪資規則重算。國定假日未出勤的月薪可能已包含給薪，因此補登不一定增加應付薪資。'}</p>
              {preview.delta.netSalary === 0 && <p className="text-sm font-medium">本次應付薪資差額為 0；仍會保存假日與更正歷程。</p>}
              <ul className="space-y-1 text-sm">{preview.holidays.map((holiday) => <li key={holiday.date}>{holiday.date} · {holidayTypeLabels[holiday.holidayType]} · {holiday.name} · {holiday.mode === 'add' ? '補登新日期' : '更正既有類別，保留打卡'}</li>)}</ul>
              <p className="text-sm"><strong>更正原因：</strong>{preview.reason}</p>
              <p className="text-sm"><strong>差額處理：</strong>{paymentHandlingLabels[preview.paymentHandling]}</p>
              <Label className="flex items-start gap-2 leading-6"><input type="checkbox" className="mt-1 h-4 w-4" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />我已核對日期、金額及發薪狀態，確認保存本次更正。</Label>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => { setPreview(null); saveRequest.current = null; setConfirmed(false); setError(''); requestAnimationFrame(() => document.getElementById('correction-date-0')?.focus()); }}>返回修改</Button>
                <Button type="button" disabled={busy || !confirmed} onClick={() => void save()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}確認保存更正</Button>
              </div>
            </> : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void requestPreview(); }}>
              <h3 className="font-semibold">指定此員工與此月份的日期</h3>
              <p className="text-sm text-muted-foreground">已有出勤或假日的日期，請選擇「更正既有類別」；既有打卡時間會保留。</p>
              <fieldset disabled={busy || conflict || !record.employeeId} className="space-y-4">
                {holidays.map((holiday, index) => {
                  const existing = record.attendanceData?.find((row) => normalizeSnapshotDate(row.date) === holiday.date);
                  return <div key={index} className="space-y-3 rounded-md border p-3">
                    <div className="flex items-center justify-between"><span className="text-sm font-medium">日期 {index + 1}</span><Button type="button" variant="ghost" size="sm" aria-label={`移除日期 ${index + 1}`} disabled={holidays.length === 1} onClick={() => setHolidays((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}><Trash2 className="h-4 w-4" /></Button></div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1"><Label htmlFor={`correction-date-${index}`}>日期</Label><Input id={`correction-date-${index}`} type="date" min={bounds?.min} max={bounds?.max} value={holiday.date} required onChange={(event) => updateHoliday(index, { date: event.target.value })} /></div>
                      <div className="space-y-1"><Label htmlFor={`correction-mode-${index}`}>操作方式</Label><select id={`correction-mode-${index}`} className={selectClass} value={holiday.mode} onChange={(event) => updateHoliday(index, { mode: event.target.value as 'add' | 'replace' })}><option value="add">補登新日期</option><option value="replace">更正既有類別</option></select></div>
                      <div className="space-y-1"><Label htmlFor={`correction-type-${index}`}>假日類別</Label><select id={`correction-type-${index}`} className={selectClass} value={holiday.holidayType} onChange={(event) => { const type = event.target.value as HolidayCorrectionInput['holidayType']; updateHoliday(index, { holidayType: type, name: holidayTypeLabels[type] }); }}>{Object.entries(holidayTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
                      <div className="space-y-1"><Label htmlFor={`correction-name-${index}`}>假日名稱</Label><Input id={`correction-name-${index}`} value={holiday.name} maxLength={100} required onChange={(event) => updateHoliday(index, { name: event.target.value })} /></div>
                    </div>
                    {existing && <p className="text-sm text-amber-800">既有紀錄：{existing.holidayType || existing._holidayType || (existing.isHoliday ? '假日出勤' : '一般出勤')}，打卡 {existing.clockIn || '無'} – {existing.clockOut || '無'}。請核對並明確選擇更正既有類別。</p>}
                  </div>;
                })}
                <Button type="button" variant="outline" disabled={holidays.length >= 31} onClick={() => setHolidays((rows) => [...rows, newHoliday()])}><Plus className="mr-1 h-4 w-4" />加入日期</Button>
                <div className="space-y-1"><Label htmlFor="correction-reason">更正原因（必填）</Label><Textarea id="correction-reason" value={reason} maxLength={1000} required onChange={(event) => setReason(event.target.value)} placeholder="例如：結算前遺漏假日設定，已核對適用日期與員工。" /></div>
                <div className="space-y-1"><Label htmlFor="correction-payment">發薪狀態與差額處理（必選）</Label><select id="correction-payment" className={selectClass} required value={paymentHandling} onChange={(event) => setPaymentHandling(event.target.value as PaymentHandling)}><option value="" disabled>請核對後選擇</option>{Object.entries(paymentHandlingLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
              </fieldset>
              {!record.employeeId && <p role="alert" className="text-sm text-red-700">此紀錄缺少員工識別，請先由管理員核對原始紀錄。</p>}
              <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || conflict || !record.employeeId}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}預覽更正與差額</Button></div>
            </form>}
          </div>
          <aside className="min-w-0 space-y-3 border-t pt-4 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0" aria-label="更正歷程">
            <h3 className="font-semibold">更正歷程</h3>
            {!corrections.length && <p className="text-sm text-muted-foreground">尚無假日更正紀錄。</p>}
            <ol className="space-y-4">{corrections.map((correction) => <li key={correction.id} className="space-y-1 break-words border-b pb-3 text-sm"><p className="font-medium">修訂 {correction.revision} · {correction.actorRole}</p><p className="text-xs text-muted-foreground">{new Date(correction.createdAt).toLocaleString('zh-TW')}</p><p>{correction.reason}</p><p>應付差額：{formatCurrency(correction.delta.netSalary)}</p><p>{paymentHandlingLabels[correction.paymentHandling]}</p><p>{correction.holidays.map((holiday) => `${holiday.date} ${holidayTypeLabels[holiday.holidayType]}`).join('、')}</p></li>)}</ol>
          </aside>
        </div>}
      </DialogContent>
    </Dialog>
  );
}
