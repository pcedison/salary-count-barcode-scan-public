import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatCurrency } from '@/lib/utils';
import { calculateHistoryRecordTotals, initialHistoryAllowances, type HistoryAllowanceItem, type HistoryDeductionItem, type HistorySpecialLeaveInfo } from '@/lib/historyRecordMath';
import { correctionErrorMessage, holidayTypeLabels, paymentHandlingLabels, type PaymentHandling } from '@/lib/holidayCorrection';
import type { SalaryRecord } from '@/hooks/useHistoryData';

interface Props {
  record: SalaryRecord | null;
  isOpen: boolean;
  onClose: () => void;
  onReload?: (id: number) => void;
  onSave: (id: number, data: Record<string, unknown>) => Promise<void>;
  isSaving: boolean;
}
const emptyLeave = (): HistorySpecialLeaveInfo => ({ usedDays: 0, usedDates: [], cashDays: 0, cashAmount: 0 });

export default function EditHistoryRecordModal({ record, isOpen, onClose, onReload, onSave, isSaving }: Props) {
  const [allowances, setAllowances] = useState<HistoryAllowanceItem[]>([]);
  const [allowancesTouched, setAllowancesTouched] = useState(false);
  const [deductions, setDeductions] = useState<HistoryDeductionItem[]>([]);
  const [baseSalary, setBaseSalary] = useState(0);
  const [housingAllowance, setHousingAllowance] = useState(0);
  const [specialLeaveInfo, setSpecialLeaveInfo] = useState<HistorySpecialLeaveInfo | null>(null);
  const [reason, setReason] = useState('');
  const [paymentHandling, setPaymentHandling] = useState<PaymentHandling | ''>('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const idempotencyKey = useRef('');
  const pendingRequest = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!record || !isOpen) return;
    setAllowances(initialHistoryAllowances(record));
    setAllowancesTouched(false);
    setDeductions(structuredClone(record.deductions || []));
    setBaseSalary(record.baseSalary);
    setHousingAllowance(record.housingAllowance || 0);
    setSpecialLeaveInfo(record.specialLeaveInfo ? structuredClone(record.specialLeaveInfo) : null);
    setReason(''); setPaymentHandling(''); setConfirmed(false); setError(''); setConflict(false);
    idempotencyKey.current = crypto.randomUUID();
    pendingRequest.current = null;
  }, [record, isOpen]);
  if (!record) return null;
  const totals = calculateHistoryRecordTotals({ allowances: allowancesTouched ? allowances : [{ name: '原結算福利津貼', amount: record.welfareAllowance ?? 0 }], deductions, baseSalary, housingAllowance, specialLeaveInfo, totalOvertimePay: record.totalOvertimePay, totalHolidayPay: record.totalHolidayPay });
  const originalAllowanceDifference = (record.welfareAllowance ?? 0) - (record.allowances ?? []).reduce((sum, row) => sum + row.amount, 0);
  const delta = totals.netSalary - record.netSalary;
  // On an uncertain save, keep the exact request and key for a safe retry.
  const locked = isSaving || conflict || pendingRequest.current !== null;
  const handleSave = async () => {
    if (inFlight.current || conflict || !confirmed) return;
    if (!reason.trim()) { setError('請填寫更正原因。'); return; }
    if (!paymentHandling) { setError('請選擇發薪狀態與差額處理方式。'); return; }
    inFlight.current = true;
    setError('');
    if (!pendingRequest.current) pendingRequest.current = {
      revision: record.revision,
      baseSalary, housingAllowance, ...(allowancesTouched ? { allowances } : {}), deductions, specialLeaveInfo,
      reason: reason.trim(), paymentHandling, idempotencyKey: idempotencyKey.current,
    };
    try { await onSave(record.id, pendingRequest.current); }
    catch (err) {
      setError(correctionErrorMessage(err));
      if (err instanceof Error && err.message.startsWith('409:')) setConflict(true);
      // Validation/auth failures are definitive; edits can be fixed before retrying.
      else if (err instanceof Error && /^(400|401|403|422):/.test(err.message)) pendingRequest.current = null;
    } finally { inFlight.current = false; }
  };

  return <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !inFlight.current) onClose(); }}>
    <DialogContent className="max-w-4xl w-[calc(100%-1rem)] max-h-[90dvh] overflow-y-auto p-4 sm:p-6">
      <DialogHeader><DialogTitle>歷史薪資金額更正</DialogTitle><DialogDescription>{record.employeeName || `員工 #${record.employeeId ?? '未指定'}`} · {record.salaryYear} 年 {record.salaryMonth} 月 · 修訂 {record.revision}</DialogDescription></DialogHeader>
      <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">此處更正金額項目並保留原有加班與假日計算。新增或變更假日請回到歷史列表選擇「假日更正」。已發薪或待核對的差額需人工處理，系統不會付款或通知員工。</p>
      {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {conflict && onReload && <Button type="button" variant="outline" onClick={() => onReload(record.id)}>重新讀取最新紀錄</Button>}
{originalAllowanceDifference !== 0 && <p className="rounded-md bg-muted p-3 text-sm">原結算福利津貼 {formatCurrency(record.welfareAllowance ?? 0)} 與舊津貼明細合計不同。未修改津貼時保留原結算金額；明確修改津貼後，將按目前明細合計重算並在下方預覽。</p>}
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void handleSave(); }}>
        <fieldset disabled={locked} className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="edit-base-salary">基本薪資</Label><Input id="edit-base-salary" type="number" min={0} step="0.01" required value={baseSalary} onChange={(event) => { setBaseSalary(Number(event.target.value)); setConfirmed(false); }} /></div><div className="space-y-1"><Label htmlFor="edit-housing">住宿津貼</Label><Input id="edit-housing" type="number" min={0} step="0.01" required value={housingAllowance} onChange={(event) => { setHousingAllowance(Number(event.target.value)); setConfirmed(false); }} /></div></div>
          <section className="space-y-3"><h3 className="font-semibold">津貼項目</h3>{allowances.map((allowance, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-2"><div><Label htmlFor={`edit-allowance-name-${index}`} className="sr-only">津貼 {index + 1} 名稱</Label><Input id={`edit-allowance-name-${index}`} value={allowance.name} maxLength={100} required onChange={(event) => { setAllowances((rows) => rows.map((row, i) => i === index ? { ...row, name: event.target.value } : row)); setAllowancesTouched(true); setConfirmed(false); }} /></div><div><Label htmlFor={`edit-allowance-amount-${index}`} className="sr-only">津貼 {index + 1} 金額</Label><Input id={`edit-allowance-amount-${index}`} type="number" min={0} step="0.01" value={allowance.amount} required onChange={(event) => { setAllowances((rows) => rows.map((row, i) => i === index ? { ...row, amount: Number(event.target.value) } : row)); setAllowancesTouched(true); setConfirmed(false); }} /></div><Button type="button" variant="ghost" aria-label={`移除津貼 ${index + 1}`} onClick={() => { setAllowances((rows) => rows.filter((_, i) => i !== index)); setAllowancesTouched(true); setConfirmed(false); }}><Trash2 className="h-4 w-4" /></Button></div>)}<Button type="button" variant="outline" size="sm" onClick={() => { setAllowances((rows) => [...rows, { name: '', amount: 0 }]); setAllowancesTouched(true); setConfirmed(false); }}><Plus className="mr-1 h-4 w-4" />新增津貼</Button></section>
          <section className="space-y-3"><h3 className="font-semibold">扣款項目</h3>{deductions.map((deduction, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_7rem_auto] gap-2"><div><Label htmlFor={`edit-deduction-name-${index}`} className="sr-only">扣款 {index + 1} 名稱</Label><Input id={`edit-deduction-name-${index}`} value={deduction.name} maxLength={100} required onChange={(event) => { setDeductions((rows) => rows.map((row, i) => i === index ? { ...row, name: event.target.value } : row)); setConfirmed(false); }} /></div><div><Label htmlFor={`edit-deduction-amount-${index}`} className="sr-only">扣款 {index + 1} 金額</Label><Input id={`edit-deduction-amount-${index}`} type="number" min={0} step="0.01" value={deduction.amount} required onChange={(event) => { setDeductions((rows) => rows.map((row, i) => i === index ? { ...row, amount: Number(event.target.value) } : row)); setConfirmed(false); }} /></div><Button type="button" variant="ghost" aria-label={`移除扣款 ${index + 1}`} onClick={() => { setDeductions((rows) => rows.filter((_, i) => i !== index)); setConfirmed(false); }}><Trash2 className="h-4 w-4" /></Button></div>)}<Button type="button" variant="outline" size="sm" onClick={() => { setDeductions((rows) => [...rows, { name: '', amount: 0 }]); setConfirmed(false); }}><Plus className="mr-1 h-4 w-4" />新增扣款</Button></section>
          <section className="space-y-3"><h3 className="font-semibold">特休結算快照</h3><p className="text-sm text-muted-foreground">已使用天數 {specialLeaveInfo?.usedDays ?? 0}，日期 {(specialLeaveInfo?.usedDates ?? []).join('、') || '無'}。</p><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1"><Label htmlFor="edit-cash-days">折現天數</Label><Input id="edit-cash-days" type="number" min={0} step="0.5" value={specialLeaveInfo?.cashDays ?? 0} onChange={(event) => { setSpecialLeaveInfo({ ...(specialLeaveInfo ?? emptyLeave()), cashDays: Number(event.target.value) }); setConfirmed(false); }} /></div><div className="space-y-1"><Label htmlFor="edit-cash-amount">折現金額</Label><Input id="edit-cash-amount" type="number" min={0} step="0.01" value={specialLeaveInfo?.cashAmount ?? 0} onChange={(event) => { setSpecialLeaveInfo({ ...(specialLeaveInfo ?? emptyLeave()), cashAmount: Number(event.target.value) }); setConfirmed(false); }} /></div></div></section>
          <div className="space-y-1"><Label htmlFor="edit-correction-reason">更正原因（必填）</Label><Textarea id="edit-correction-reason" required maxLength={1000} value={reason} onChange={(event) => { setReason(event.target.value); setConfirmed(false); }} /></div>
          <div className="space-y-1"><Label htmlFor="edit-payment-handling">發薪狀態與差額處理（必選）</Label><select id="edit-payment-handling" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" required value={paymentHandling} onChange={(event) => { setPaymentHandling(event.target.value as PaymentHandling); setConfirmed(false); }}><option value="" disabled>請核對後選擇</option>{Object.entries(paymentHandlingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        </fieldset>
        <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">查看已封存的出勤與假日（唯讀）</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-2 text-left">日期</th><th className="p-2 text-left">上班</th><th className="p-2 text-left">下班</th><th className="p-2 text-left">假日類別</th></tr></thead><tbody>{(record.attendanceData ?? []).map((attendance, index) => <tr className="border-b" key={`${attendance.date}-${index}`}><td className="p-2">{attendance.date}</td><td className="p-2">{attendance.clockIn || '無'}</td><td className="p-2">{attendance.clockOut || '無'}</td><td className="p-2">{holidayTypeLabels[attendance.holidayType as keyof typeof holidayTypeLabels] || attendance.holidayType || (attendance.isHoliday ? '假日出勤' : '一般出勤')}</td></tr>)}</tbody></table></div></details>
        <section className="rounded-md border bg-muted/30 p-3"><h3 className="mb-3 font-semibold">金額更正預覽</h3><div className="grid gap-3 text-sm tabular-nums sm:grid-cols-3"><p>更正前應付薪資<br /><strong className="text-lg">{formatCurrency(record.netSalary)}</strong></p><p>更正後應付薪資<br /><strong className="text-lg">{formatCurrency(totals.netSalary)}</strong></p><p>應付差額<br /><strong className="text-lg">{delta > 0 ? '+' : ''}{formatCurrency(delta)}</strong></p></div><p className="mt-3 text-sm">總薪資 {formatCurrency(totals.grossSalary)} · 扣款 {formatCurrency(totals.totalDeductions)} · 原加班費 {formatCurrency(record.totalOvertimePay)} · 原假日加給 {formatCurrency(record.totalHolidayPay)}</p></section>
        <Label className="flex items-start gap-2 leading-6"><input type="checkbox" className="mt-1 h-4 w-4" checked={confirmed} disabled={isSaving || conflict} onChange={(event) => setConfirmed(event.target.checked)} />我已核對金額、原因與發薪狀態，確認保存本次金額更正。</Label>
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={isSaving} onClick={onClose}>取消</Button><Button type="submit" disabled={isSaving || conflict || !confirmed}>{isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}確認保存金額更正</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
