import { formatCurrency, getMonthName, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { useToast } from "@/hooks/use-toast";

interface SalaryResultTableProps {
  result: {
    salaryYear: number;
    salaryMonth: number;
    baseSalary: number;
    housingAllowance?: number;
    welfareAllowance?: number;
    totalOT1Hours: number;
    totalOT2Hours: number;
    totalOvertimePay: number;
    paidLeaveDays?: number;
    paidLeavePay?: number;
    holidayDays: number;
    holidayDates?: string[];
    holidayDailySalary: number;
    totalHolidayPay: number;
    grossSalary: number;
    deductions: Array<{ name: string; amount: number }>;
    totalDeductions: number;
    netSalary: number;
  };
  settings: any;
  onFinalize: () => void;
}

type ResultRow = {
  label: string;
  detail: string;
  amount: string;
  tone?: 'default' | 'muted' | 'danger' | 'summary';
};

export default function SalaryResultTable({ result, settings, onFinalize }: SalaryResultTableProps) {
  const { toast } = useToast();
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [calculationNotes, setCalculationNotes] = useState([
    "正常工時：8小時/天，超過算為加班",
    `加班費計算：前兩小時以${settings?.ot1Multiplier || 1.34}倍計算(OT1)，超過兩小時以${settings?.ot2Multiplier || 1.67}倍計算(OT2)`,
    `基本時薪：${settings?.baseHourlyRate || 119}元/小時`,
    `假日加班：以日薪計算，每日${result.holidayDailySalary}元`
  ]);

  const handleEditNotes = () => {
    setIsEditingNotes(true);
  };

  const handleSaveNotes = () => {
    setIsEditingNotes(false);

    toast({
      title: "已更新",
      description: "計算說明已更新。",
    });
  };

  const handleNoteChange = (index: number, value: string) => {
    const newNotes = [...calculationNotes];
    newNotes[index] = value;
    setCalculationNotes(newNotes);
  };

  const rows: ResultRow[] = [
    {
      label: '基本薪資',
      detail: '-',
      amount: formatCurrency(result.baseSalary),
    },
    ...(result.housingAllowance && result.housingAllowance > 0
      ? [{
          label: '住房津貼',
          detail: '-',
          amount: formatCurrency(result.housingAllowance),
          tone: 'muted' as const,
        }]
      : []),
    ...(result.welfareAllowance && result.welfareAllowance > 0
      ? [{
          label: '福利金',
          detail: '-',
          amount: formatCurrency(result.welfareAllowance),
          tone: 'default' as const,
        }]
      : []),
    {
      label: '加班費',
      detail: `OT1: ${result.totalOT1Hours.toFixed(1)}小時, OT2: ${result.totalOT2Hours.toFixed(1)}小時`,
      amount: formatCurrency(result.totalOvertimePay),
      tone: 'muted',
    },
    ...(result.paidLeaveDays && result.paidLeaveDays > 0
      ? [{
          label: '特休',
          detail: `${result.paidLeaveDays}天`,
          amount: '有薪假',
        }]
      : []),
    {
      label: '假日加班',
      detail: `${result.holidayDays}天${result.holidayDates && result.holidayDates.length > 0 ? ` (${result.holidayDates.join(', ')})` : ''}`,
      amount: formatCurrency(result.totalHolidayPay),
      tone: 'muted',
    },
    ...result.deductions.map((deduction) => ({
      label: deduction.name,
      detail: '-',
      amount: deduction.amount > 0 ? `-${formatCurrency(deduction.amount)}` : '0',
      tone: 'danger' as const,
    })),
    {
      label: '實發金額',
      detail: '-',
      amount: formatCurrency(result.netSalary),
      tone: 'summary',
    }
  ];

  return (
    <div id="resultTable" className="mt-8 space-y-4">
      <h2 className="text-xl font-bold">
        {result.salaryYear}年{getMonthName(result.salaryMonth)}薪資計算結果
      </h2>

      <div className="rounded-lg bg-white shadow">
        <div className="space-y-3 p-4 md:hidden">
          {rows.map((row, index) => (
            <div
              key={`${row.label}-${index}`}
              className={cn(
                "rounded-xl border border-gray-200 p-4",
                row.tone === 'muted' && 'bg-gray-50',
                row.tone === 'danger' && 'border-red-200 bg-red-50/60',
                row.tone === 'summary' && 'border-slate-200 bg-slate-50'
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className={cn(
                    "text-sm font-medium",
                    row.tone === 'danger' ? 'text-error' : 'text-gray-900'
                  )}>
                    {row.label}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-gray-500">{row.detail}</div>
                </div>
                <div className={cn(
                  "text-right font-['Roboto_Mono'] text-sm font-semibold",
                  row.tone === 'danger' && 'text-error',
                  row.tone === 'summary' && 'text-slate-900'
                )}>
                  {row.amount}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr className="bg-gray-50">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">項目</th>
                <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">明細</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 lg:px-6">金額</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={`${row.label}-${index}`}
                  className={cn(
                    row.tone === 'muted' && 'bg-gray-50',
                    row.tone === 'summary' && 'bg-gray-100 font-bold'
                  )}
                >
                  <td className={cn(
                    "px-4 py-4 font-medium whitespace-nowrap lg:px-6",
                    row.tone === 'danger' && 'text-error'
                  )}>
                    {row.label}
                  </td>
                  <td className="px-4 py-4 text-center font-['Roboto_Mono'] lg:px-6">{row.detail}</td>
                  <td className={cn(
                    "px-4 py-4 text-right font-['Roboto_Mono'] whitespace-nowrap lg:px-6",
                    row.tone === 'danger' && 'text-error'
                  )}>
                    {row.amount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="relative rounded-lg bg-gray-50 p-4 shadow-sm sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <h3 className="text-lg font-medium">計算說明</h3>
          <button
            className="flex items-center text-sm text-warning hover:text-amber-600"
            onClick={isEditingNotes ? handleSaveNotes : handleEditNotes}
          >
            <span className="material-icons mr-1 text-sm">{isEditingNotes ? 'save' : 'edit'}</span>
            {isEditingNotes ? '儲存' : '編輯'}
          </button>
        </div>

        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
          {isEditingNotes ? (
            calculationNotes.map((note, index) => (
              <li key={index}>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => handleNoteChange(index, e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2"
                />
              </li>
            ))
          ) : (
            calculationNotes.map((note, index) => (
              <li key={index}>{note}</li>
            ))
          )}
        </ul>
      </div>

      <div className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-4 shadow-sm sm:p-6">
        <div className="mx-auto max-w-2xl text-center">
          <h3 className="text-lg font-medium">完成薪資結算</h3>
          <p className="mt-2 text-sm text-gray-600 sm:text-base">
            結算後將清除目前考勤紀錄，並將結果儲存至歷史紀錄中
          </p>
          <Button
            onClick={onFinalize}
            className="mt-4 w-full border-2 border-slate-500 bg-slate-700 px-8 py-3 text-base font-medium text-white hover:bg-slate-800 sm:w-auto sm:text-lg"
          >
            結算並清除
          </Button>
        </div>
      </div>
    </div>
  );
}
