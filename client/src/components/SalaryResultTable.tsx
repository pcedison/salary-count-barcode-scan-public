import { formatCurrency, getMonthName } from '@/lib/utils';
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

export default function SalaryResultTable({ result, settings, onFinalize }: SalaryResultTableProps) {
  const { toast } = useToast();
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [calculationNotes, setCalculationNotes] = useState([
    "正常工時：8小時/天，超過算為加班",
    `加班費計算：前兩小時以${settings?.ot1Multiplier || 1.34}倍計算(OT1)，超過兩小時以${settings?.ot2Multiplier || 1.67}倍計算(OT2)`,
    `基本時薪：${settings?.baseHourlyRate || 119}元/小時`,
    `假日加班：以日薪計算，每日${result.holidayDailySalary}元`
  ]);

  const handlePrint = () => {
    window.print();
  };

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

  return (
    <div id="resultTable" className="mt-8 space-y-4">
      <h2 className="text-xl font-bold">{result.salaryYear}年{getMonthName(result.salaryMonth)}薪資計算結果</h2>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">項目</th>
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">明細</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">金額</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-6 py-4 whitespace-nowrap font-medium">基本薪資</td>
              <td className="px-6 py-4 whitespace-nowrap text-center">-</td>
              <td className="px-6 py-4 whitespace-nowrap text-right font-['Roboto_Mono']">{formatCurrency(result.baseSalary)}</td>
            </tr>

            {result.housingAllowance && result.housingAllowance > 0 ? (
              <tr className="bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap font-medium">住房津貼</td>
                <td className="px-6 py-4 whitespace-nowrap text-center">-</td>
                <td className="px-6 py-4 whitespace-nowrap text-right font-['Roboto_Mono']">{formatCurrency(result.housingAllowance)}</td>
              </tr>
            ) : null}

            {result.welfareAllowance && result.welfareAllowance > 0 ? (
              <tr className={result.housingAllowance && result.housingAllowance > 0 ? '' : 'bg-gray-50'}>
                <td className="px-6 py-4 whitespace-nowrap font-medium">福利金</td>
                <td className="px-6 py-4 whitespace-nowrap text-center">-</td>
                <td className="px-6 py-4 whitespace-nowrap text-right font-['Roboto_Mono']">{formatCurrency(result.welfareAllowance)}</td>
              </tr>
            ) : null}

            <tr className={
              ((result.housingAllowance && result.housingAllowance > 0) ||
               (result.welfareAllowance && result.welfareAllowance > 0)) ?
              '' : 'bg-gray-50'
            }>
              <td className="px-6 py-4 whitespace-nowrap font-medium">加班費</td>
              <td className="px-6 py-4 whitespace-nowrap text-center font-['Roboto_Mono']">
                OT1: {result.totalOT1Hours.toFixed(1)}小時, OT2: {result.totalOT2Hours.toFixed(1)}小時
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right font-['Roboto_Mono']">{formatCurrency(result.totalOvertimePay)}</td>
            </tr>

            {result.paidLeaveDays && result.paidLeaveDays > 0 ? (
              <tr className="bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap font-medium">特休</td>
                <td className="px-6 py-4 whitespace-nowrap text-center font-['Roboto_Mono']">{result.paidLeaveDays}天</td>
                <td className="px-6 py-4 whitespace-nowrap text-right font-['Roboto_Mono']">有薪假</td>
              </tr>
            ) : null}

            <tr className={result.paidLeaveDays && result.paidLeaveDays > 0 ? '' : 'bg-gray-50'}>
              <td className="px-6 py-4 whitespace-nowrap font-medium">假日加班</td>
              <td className="px-6 py-4 text-center font-['Roboto_Mono']">
                {result.holidayDays}天
                {result.holidayDates && result.holidayDates.length > 0 && (
                  <span className="text-gray-600 ml-2">
                    ({result.holidayDates.join(', ')})
                  </span>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right font-['Roboto_Mono']">{formatCurrency(result.totalHolidayPay)}</td>
            </tr>

            {result.deductions.map((deduction, index) => (
              <tr key={`deduction-${index}`} className={index % 2 === 0 ? 'bg-gray-50' : ''}>
                <td className="px-6 py-4 whitespace-nowrap font-medium text-error">{deduction.name}</td>
                <td className="px-6 py-4 whitespace-nowrap text-center">-</td>
                <td className="px-6 py-4 whitespace-nowrap text-right font-['Roboto_Mono'] text-error">
                  {deduction.amount > 0 ? `-${formatCurrency(deduction.amount)}` : '0'}
                </td>
              </tr>
            ))}

            <tr className="bg-gray-100 font-bold">
              <td className="px-6 py-4 whitespace-nowrap">實發金額</td>
              <td className="px-6 py-4 whitespace-nowrap text-center">-</td>
              <td className="px-6 py-4 whitespace-nowrap text-right font-['Roboto_Mono']">{formatCurrency(result.netSalary)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Calculation Notes */}
      <div className="bg-gray-50 p-6 rounded-lg shadow-sm relative">
        <div className="flex justify-between items-start">
          <h3 className="text-lg font-medium mb-3">計算說明</h3>
          <button
            className="text-warning text-sm hover:text-amber-600 flex items-center"
            onClick={isEditingNotes ? handleSaveNotes : handleEditNotes}
          >
            <span className="material-icons text-sm mr-1">{isEditingNotes ? 'save' : 'edit'}</span>
            {isEditingNotes ? '儲存' : '編輯'}
          </button>
        </div>
        <ul className="space-y-2 text-sm pl-5 list-disc">
          {isEditingNotes ? (
            calculationNotes.map((note, index) => (
              <li key={index}>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => handleNoteChange(index, e.target.value)}
                  className="w-full px-3 py-1 border border-gray-300 rounded-md"
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

      {/* 結算按鈕 */}
      <div className="mt-8 p-6 bg-gray-50 border border-gray-200 rounded-lg shadow-sm flex flex-col items-center">
        <h3 className="text-lg font-medium mb-2">完成薪資結算</h3>
        <p className="text-center text-gray-600 mb-4">結算後將清除目前考勤紀錄，並將結果儲存至歷史紀錄中</p>
        <Button
          onClick={onFinalize}
          className="bg-slate-700 hover:bg-slate-800 text-white px-8 py-3 rounded-md text-lg font-medium border-2 border-slate-500"
        >
          結算並清除
        </Button>
      </div>
    </div>
  );
}
