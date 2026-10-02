import React from 'react';
import { calculateOvertime, calculateDailyOvertimePay } from '@/lib/salaryCalculations';
import { reconcileArchivedOvertime, type OvertimeHoursSnapshot } from '@shared/utils/archivedOvertime';

interface PrintableSalarySheetProps {
  result: {
    archived?: boolean;
    recordId?: number;
    revision?: number;
    employeeId?: number;
    employeeName?: string;
    salaryYear: number;
    salaryMonth: number;
    baseSalary: number;
    housingAllowance?: number;
    welfareAllowance?: number;
    allowances?: Array<{ name: string; amount: number; description?: string }>;
    totalOT1Hours?: number | null;
    totalOT2Hours?: number | null;
    totalOvertimePay: number;
    holidayDays: number;
    totalHolidayPay: number;
    grossSalary: number;
    deductions: Array<{ name: string; amount: number }>;
    totalDeductions?: number;
    netSalary: number;
    attendanceData: Array<{
      date: string;
      clockIn: string;
      clockOut: string;
      isHoliday: boolean;
      holidayType?: string;
      overtimeHours?: OvertimeHoursSnapshot;
    }>;
    specialLeaveInfo?: {
      usedDays: number;
      usedDates: string[];
      cashDays: number;
      cashAmount: number;
      notes?: string;
    };
  };
}

export default function PrintableSalarySheet({ result }: PrintableSalarySheetProps) {

// 安全數值處理函數
const safeNumber = (value: any): number => {
  if (value === null || value === undefined) return 0;
  const num = Number(value);
  return isNaN(num) ? 0 : num;
};

const formatHours = (value: number): string => Number.isInteger(value * 10) ? value.toFixed(1) : String(value);

// 根據假日類型返回顯示文字
const getHolidayLabel = (holidayType?: string): string => {
  switch (holidayType) {
    case 'worked':
      return '假日出勤';
    case 'national_holiday':
      return '國定假日';
    case 'sick_leave':
      return '病假';
    case 'personal_leave':
      return '事假';
    case 'temporary_stop_work_and_classes':
      return '臨時停止上班上課';
    case 'typhoon_leave':
      return '颱風假';
    case 'special_leave':
      return '特別休假';
    case 'special_leave_cash':
      return '特休折現';
    default:
      return '假日';
  }
};

// 計算日期對應加班費 - 使用統一模組
const calculateDailyOT = (clockIn: string, clockOut: string): {ot1: number, ot2: number, pay: number} => {
  // 檢查無效打卡記錄（包括 '--:--'）
  if (!clockIn || !clockOut || clockIn === '--:--' || clockOut === '--:--') {
    return { ot1: 0, ot2: 0, pay: 0 };
  }

  // 使用統一的加班計算函數
  const { ot1, ot2 } = calculateOvertime(clockIn, clockOut);

  // 使用共享模組的標準化函數計算加班費
  const dailyOTPay = calculateDailyOvertimePay(clockIn, clockOut, result.baseSalary);

  return {
    ot1: safeNumber(ot1),
    ot2: safeNumber(ot2),
    pay: safeNumber(dailyOTPay)
  };
  };

  // 按日期排序考勤記錄
  const sortedAttendance = result.attendanceData.filter(record => record.holidayType !== 'special_leave_cash').sort((a, b) => {
    return new Date(a.date.replace(/\//g, '-')).getTime() - new Date(b.date.replace(/\//g, '-')).getTime();
  });

  const archivedHours = result.archived ? reconcileArchivedOvertime({ ...result, attendanceData: sortedAttendance }) : null;
  // 每日時數採已保存明細；舊資料的打卡推導須先與結算合計吻合。
  const attendanceWithOT = sortedAttendance.map((record, index) => {
    const dailyOT = result.archived ? { ot1: 0, ot2: 0, pay: 0 } : calculateDailyOT(record.clockIn, record.clockOut);
    return {
      ...record,
      ot1: dailyOT.ot1,
      ot2: dailyOT.ot2,
      pay: dailyOT.pay,
      archivedHours: archivedHours?.rows[index] ?? null
    };
  });

  // 計算合計加班時數
  const totalOT1 = result.archived ? safeNumber(result.totalOT1Hours) : safeNumber(attendanceWithOT.reduce((sum, record) => sum + safeNumber(record.ot1), 0));
  const totalOT2 = result.archived ? safeNumber(result.totalOT2Hours) : safeNumber(attendanceWithOT.reduce((sum, record) => sum + safeNumber(record.ot2), 0));
  // 總加班費
  const totalOTPay = result.archived ? safeNumber(result.totalOvertimePay) : safeNumber(attendanceWithOT.reduce((sum, record) => sum + safeNumber(record.pay), 0));
  const specialLeaveCashAmount = safeNumber(result.specialLeaveInfo?.cashAmount);
  const visibleDeductions = (result.deductions ?? []).filter(deduction =>
    Number.isFinite(safeNumber(deduction.amount)) && safeNumber(deduction.amount) > 0);
  // 舊 CSV 可分別保存扣款總額與部分明細，差異須保留，但不重算薪資快照。
  const visibleDeductionTotal = visibleDeductions.reduce((sum, deduction) => sum + safeNumber(deduction.amount), 0);
  const deductionDifference = result.archived && Number.isFinite(result.totalDeductions)
    ? Math.round((visibleDeductionTotal - result.totalDeductions!) * 100) / 100 : 0;

  // 檢查日期是否為特別假
  const isSpecialLeaveDate = (date: string): boolean => {
    if (!result.specialLeaveInfo?.usedDates) return false;
    // 標準化日期格式為 YYYY-MM-DD，同時標準化兩邊進行比對
    const normalizedDate = date.replace(/\//g, '-');
    return result.specialLeaveInfo.usedDates.some(d => {
      const normalizedUsedDate = d.replace(/\//g, '-');
      return normalizedUsedDate === normalizedDate;
    });
  };

  // 渲染出勤記錄行
  const renderAttendanceRows = () => {
    return attendanceWithOT.map((record, index) => {
      const isSpecialLeave = isSpecialLeaveDate(record.date);
      const rowClass = record.isHoliday ? 'holiday-row' : (isSpecialLeave ? 'special-leave-row' : '');

      return (
        <tr key={index} className={rowClass}>
          <td className="date-cell">
            {record.date}
            {record.isHoliday && (
              <span style={{ marginLeft: '4px', fontWeight: 'bold' }}>
                {getHolidayLabel(record.holidayType)}
              </span>
            )}
            {isSpecialLeave && !record.isHoliday && (
              <span style={{ marginLeft: '4px', fontWeight: 'bold', color: 'red' }}>
                特休
              </span>
            )}
          </td>
          <td className="time-cell">{record.clockIn}</td>
          <td className="time-cell">{record.clockOut}</td>
          <td className="number-cell">{result.archived ? record.archivedHours ? formatHours(record.archivedHours.ot1) : '待核對' : formatHours(record.ot1)}</td>
          <td className="number-cell">{result.archived ? record.archivedHours ? formatHours(record.archivedHours.ot2) : '待核對' : formatHours(record.ot2)}</td>
          <td className="amount-cell">{result.archived ? '—' : record.pay}</td>
        </tr>
      );
    });
  };

  // 渲染住宿津貼行（如果存在）
  const renderHousingAllowanceRow = () => {
    const housingAmount = safeNumber(result.housingAllowance);
    if (housingAmount > 0) {
      return (
        <tr className="summary-size-row">
          <td colSpan={5}>住宿津貼：</td>
          <td className="amount-cell">{housingAmount}</td>
        </tr>
      );
    }
    return null;
  };

  // 歷史明細可能只保存部分津貼；保存的福利合計仍是薪資快照的依據。
  const renderAllowancesRows = () => {
    if (result.allowances && result.allowances.length > 0) {
      const detailTotal = result.allowances.reduce((sum, allowance) => sum + safeNumber(allowance.amount), 0);
      const hasSavedTotal = result.archived && result.welfareAllowance !== undefined && Number.isFinite(result.welfareAllowance);
      const difference = hasSavedTotal ? Math.round((result.welfareAllowance! - detailTotal) * 100) / 100 : 0;
      return <>
        {result.allowances.map((allowance, index) => {
          const amount = safeNumber(allowance.amount);
          return amount !== 0 ? (
            <tr key={`allowance-${index}`} className="summary-size-row welfare-row">
              <td colSpan={5}>{allowance.name}：</td>
              <td className="amount-cell">{amount}</td>
            </tr>
          ) : null;
        })}
        {difference !== 0 && <tr className="summary-size-row welfare-reconciliation-row">
          <td colSpan={5}>
            歷史津貼明細差異：
            <span className="reconciliation-note">歷史明細與結算快照的對照，薪資採用已保存總額。</span>
          </td>
          <td className="amount-cell">{difference > 0 ? '+' : ''}{difference}</td>
        </tr>}
      </>;
    }
    // 向下相容：如果沒有 allowances 陣列，使用舊的 welfareAllowance 欄位
    const welfareAmount = safeNumber(result.welfareAllowance);
    if (welfareAmount > 0) {
      return (
        <tr className="summary-size-row welfare-row" style={{ fontWeight: 'bold' }}>
          <td colSpan={5}>福利津貼：</td>
          <td className="amount-cell">{welfareAmount}</td>
        </tr>
      );
    }
    return null;
  };

  return (
    <div className="print-container max-w-[210mm] mx-auto text-black bg-white">
      <style>
        {`
        .print-page {
          width: 100%;
          min-height: 297mm;
          padding: 10mm;
          background-color: white;
          box-sizing: border-box;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
          margin: 0 auto;
          overflow: visible;
        }

        @media print {
          html, body {
            width: auto;
            height: auto;
            margin: 0;
            padding: 0;
            background-color: white;
          }

          .print-page {
            width: 100%;
            min-height: 0;
            margin: 0;
            padding: 0;
            box-shadow: none;
          }

          .print-container {
            max-width: none;
            box-shadow: none;
          }

          .print-container + .print-container {
            break-before: page;
            page-break-before: always;
            margin-top: 0;
          }

          .no-print {
            display: none !important;
          }

          .salary-table thead {
            display: table-header-group;
          }

          .salary-table tr, .salary-totals {
            break-inside: avoid;
            page-break-inside: avoid;
          }

          th, td, tr {
            color-adjust: exact !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }

          @page {
            size: A4 portrait;
            margin: 10mm;
          }
        }

        .salary-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          table-layout: fixed;
          margin-top: 0px;
        }

        .salary-table th, .salary-table td {
          border: 1px solid #000;
          padding: 2px 5px;
          text-align: left;
          height: 22px;
          line-height: 1.2;
        }

        .salary-table th {
          font-weight: normal;
          background-color: #f8f8f8;
        }

        .salary-table .salary-heading-cell {
          border: 0;
          padding: 0 0 6px;
          height: auto;
          background: white;
        }

        .reconciliation-note {
          font-size: 11px;
          color: #555;
        }

        .reconciliation-note {
          display: block;
          margin-top: 3px;
        }

        .welfare-total-row {
          font-weight: bold;
        }

        .deduction-row td {
          color: #e53935;
        }

        .header-section {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          margin-bottom: 10px;
        }

        .holiday-row {
          color: red;
        }

        .special-leave-row {
          color: red;
          background-color: #fff5f5 !important;
        }

        .system-title {
          font-size: 16px;
          font-weight: bold;
          margin-bottom: 4px;
          font-family: Arial, sans-serif;
        }

        .month-title {
          font-size: 32px;
          font-weight: bold;
          margin-top: 0;
          font-family: Arial, sans-serif;
          line-height: 1;
        }

        .summary-row {
          background-color: #f9f9f9;
          font-weight: 700;
          font-size: 13px;
        }

        .summary-row .number-cell,
        .summary-row .amount-cell {
          font-weight: 700;
          font-size: 13px;
        }

        .base-salary-row {
          font-weight: 700;
          font-size: 13px;
        }

        .base-salary-row .amount-cell {
          font-weight: 700;
          font-size: 13px;
        }

        .summary-size-row {
          font-size: 13px;
        }

        .summary-size-row .amount-cell {
          font-size: 13px;
        }

        .total-amount {
          font-weight: bold;
        }

        /* 確保表格內數字對齊 */
        .number-cell {
          text-align: center !important;
          white-space: normal;
          overflow-wrap: anywhere;
        }

        .amount-cell {
          text-align: right !important;
          white-space: nowrap;
          font-family: 'Roboto Mono', monospace;
        }

        .date-cell {
          overflow-wrap: anywhere;
        }

        .time-cell {
          white-space: nowrap;
          text-align: center;
        }

        .salary-table tr:nth-child(even):not(.deduction-row):not(.summary-row):not(.total-amount) {
          background-color: #fcfcfc;
        }

        @media screen and (max-width: 640px) {
          .print-page { padding: 12px; }
          .header-section { display: block; }
          .month-title { font-size: 24px; line-height: 1.2; }
          .date-cell { white-space: nowrap; overflow-wrap: normal; }
        }
        `}
      </style>

      <div className="print-page">
        <table className="salary-table">
          <colgroup>
            <col style={{ width: '24%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '18%' }} />
          </colgroup>
          <thead>
            <tr>
              <td colSpan={6} className="salary-heading-cell">
                <div className="header-section">
                  <div>
                    <h1 className="system-title">員工薪資計算系統</h1>
                    <h2 className="month-title">{result.salaryYear}年{result.salaryMonth}月薪資明細</h2>
                    {(result.archived || result.employeeName || result.employeeId) && <p style={{ fontSize: '13px', margin: '6px 0 0' }}>
                      員工：{result.employeeName || '未提供姓名'}
                    </p>}
                  </div>
                </div>
              </td>
            </tr>
            <tr>
              <th>日期</th>
              <th>上班時間</th>
              <th>下班時間</th>
              <th>第一階段加班</th>
              <th>第二階段加班</th>
              <th>加班/假日薪資</th>
            </tr>
          </thead>
          <tbody>
            {renderAttendanceRows()}

            <tr className="summary-row">
              <td colSpan={3}>一般加班時數總計：</td>
              <td className="number-cell">{formatHours(totalOT1)}</td>
              <td className="number-cell">{formatHours(totalOT2)}</td>
              <td className="amount-cell">{totalOTPay}</td>
            </tr>
            <tr className="summary-size-row">
              <td colSpan={5}>假日給薪總計：</td>
              <td className="amount-cell">{result.archived || result.holidayDays > 0 ? safeNumber(result.totalHolidayPay) : '0'}</td>
            </tr>
            {specialLeaveCashAmount > 0 && (
              <tr className="summary-size-row special-leave-cash-row">
                <td colSpan={5}>特休折現：</td>
                <td className="amount-cell">{specialLeaveCashAmount}</td>
              </tr>
            )}
            <tr className="base-salary-row">
              <td colSpan={5}>基本底薪：</td>
              <td className="amount-cell">{safeNumber(result.baseSalary)}</td>
            </tr>
            {renderHousingAllowanceRow()}
            {renderAllowancesRows()}
            {/* 動態遍歷所有扣款項目 */}
            {visibleDeductions.map((deduction, index) => (
                <tr key={index} className="deduction-row summary-size-row">
                  <td colSpan={5}>{deduction.name}：</td>
                  <td className="amount-cell">-{safeNumber(deduction.amount)}</td>
                </tr>
            ))}
            {deductionDifference !== 0 && <tr className="deduction-row summary-size-row deduction-reconciliation-row">
              <td colSpan={5}>
                歷史扣款明細差異：
                <span className="reconciliation-note">歷史明細與結算快照的對照，薪資採用已保存總額。</span>
              </td>
              <td className="amount-cell">{deductionDifference > 0 ? '+' : ''}{deductionDifference}</td>
            </tr>}
          </tbody>
          <tbody className="salary-totals">
            {result.archived && (
              <tr className="summary-size-row"><td colSpan={5}>總薪資：</td><td className="amount-cell">{safeNumber(result.grossSalary)}</td></tr>
            )}
            <tr className="total-amount summary-size-row">
              <td colSpan={5}>實領金額：</td>
              <td className="amount-cell">{safeNumber(result.netSalary)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
