import React, { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/hooks/use-toast';
import { Loader2, Upload, FileText, Check, AlertCircle } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { useEmployees } from '@/hooks/useEmployees';
import { salaryImportTarget } from '@/lib/csvImportTarget';
import { Label } from '@/components/ui/label';
import { parseCsvRows } from '@shared/utils/csv';

interface CsvImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSuccess: () => void;
}

/**
 * CSV 匯入對話框元件
 * 支援兩種匯入模式:
 * 1. 考勤數據匯入 - 僅匯入考勤記錄
 * 2. 完整薪資記錄匯入 - 匯入包含薪資計算結果的完整記錄
 */
export function CsvImportModal({ open, onOpenChange, onImportSuccess }: CsvImportModalProps) {
  const [activeTab, setActiveTab] = useState<'attendance' | 'salary'>('attendance');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const { activeEmployees } = useEmployees();
  const [targetValue, setTargetValue] = useState('');
  const importing = useRef(false);
  const target = salaryImportTarget('employee', targetValue);
  const [parseResult, setParseResult] = useState<{
    success: boolean;
    message: string;
    preview?: any[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = () => {
    setFile(null);
    setParseResult(null);
    setTargetValue('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    // 檢查文件類型
    if (selectedFile.type !== 'text/csv' && !selectedFile.name.endsWith('.csv')) {
      toast({
        title: "檔案格式錯誤",
        description: "請選擇 CSV 格式的檔案",
        variant: "destructive",
      });
      resetState();
      return;
    }

    setFile(selectedFile);
    parseCsvFile(selectedFile);
  };

  const parseCsvFile = (file: File) => {
    setLoading(true);
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const rows = parseCsvRows(text).filter(row => row.some(cell => cell.trim()));

        // 簡單驗證CSV格式
        if (rows.length < 2) {
          throw new Error("檔案內容不足，至少需要標題行和一行數據");
        }

        // 依據當前標籤頁驗證
        if (activeTab === 'attendance') {
          // 驗證考勤數據格式
          const headers = rows[0].map(cell => cell.trim());
          const requiredFields = [['日期', 'Date'], ['上班時間', 'Clock In'], ['下班時間', 'Clock Out']];

          for (const field of requiredFields) {
            if (!field.some(alias => headers.includes(alias))) {
              throw new Error(`缺少必要欄位: ${field[0]}`);
            }
          }

          // 預覽解析結果 (最多5行)
          const preview = rows.slice(0, Math.min(6, rows.length));

          setParseResult({
            success: true,
            message: `成功解析CSV檔案，共 ${rows.length - 1} 筆考勤記錄`,
            preview
          });
        } else {
          // 驗證完整薪資記錄格式
          const snapshot = rows[0][0] === 'Salary record';
          const firstLine = snapshot ? rows.map(row => row[0]) : rows[0];
          const requiredFields = snapshot ? ['Year', 'Month', 'Base salary', 'Gross salary', 'Net salary'] : ['薪資年份', '薪資月份', '基本底薪', '總薪資', '實領金額'];

          for (const field of requiredFields) {
            if (!firstLine.includes(field)) {
              throw new Error(`缺少必要欄位: ${field}`);
            }
          }

          // 薪資記錄檔案結構較複雜，檢查是否包含考勤詳細記錄部分
          let hasAttendanceSection = false;
          for (const row of rows) {
            if (row[0] === (snapshot ? 'Finalized attendance snapshot' : '考勤詳細記錄')) {
              hasAttendanceSection = true;
              break;
            }
          }

          if (!hasAttendanceSection) {
            throw new Error('找不到封存出勤快照或考勤詳細記錄段落。');
          }

          // 顯示基本解析結果
          setParseResult({
            success: true,
            message: "成功解析完整薪資記錄檔案",
            preview: rows.slice(0, Math.min(10, rows.length))
          });
        }
      } catch (error) {
        console.error('Error parsing CSV:', error);
        setParseResult({
          success: false,
          message: error instanceof Error ? error.message : "解析檔案時發生錯誤",
        });
      } finally {
        setLoading(false);
      }
    };

    reader.onerror = () => {
      setParseResult({
        success: false,
        message: "讀取檔案時發生錯誤",
      });
      setLoading(false);
    };

    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!file || !parseResult?.success || importing.current) return;
    if (activeTab === 'salary' && !target) {
      toast({ title: '請選擇匯入員工', description: '請明確選擇員工，並確認 CSV 是該員工尚未結算的月份。', variant: 'destructive' });
      return;
    }
    importing.current = true;

    setLoading(true);

    try {
      // 讀取CSV文件內容
      const reader = new FileReader();

      // 使用Promise包裝FileReader
      const fileContent = await new Promise<string>((resolve, reject) => {
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = (e) => reject(e);
        reader.readAsText(file);
      });

      // 準備請求數據
      const requestData = {
        csvContent: fileContent,
        ...(activeTab === 'salary' ? target : {}),
      };

      // 發送API請求
      const endpoint = activeTab === 'attendance'
        ? '/api/admin/import/attendance'
        : '/api/admin/import/salary-record';

      const response = await apiRequest('POST', endpoint, requestData);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || '匯入失敗');
      }

      const result = await response.json();

      toast({
        title: "匯入成功",
        description: result.message || `已成功匯入${activeTab === 'attendance' ? '考勤記錄' : '薪資記錄'}`,
      });

      // 重置狀態並關閉對話框
      resetState();
      onOpenChange(false);
      onImportSuccess();
    } catch (error) {
      console.error('Error importing CSV:', error);
      toast({
        title: "匯入失敗",
        description: error instanceof Error ? error.message : "匯入過程中發生錯誤",
        variant: "destructive",
      });
    } finally {
      importing.current = false;
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (loading || importing.current) return;
    resetState();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[600px] w-[calc(100%-1rem)] max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>匯入 CSV 資料</DialogTitle>
          <DialogDescription>
            選擇要匯入的資料類型並上傳 CSV 檔案
          </DialogDescription>
        </DialogHeader>

        <Tabs
          defaultValue="attendance"
          value={activeTab}
          onValueChange={(value) => {
            setActiveTab(value as 'attendance' | 'salary');
            resetState();
          }}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="attendance" disabled={loading}>考勤記錄匯入</TabsTrigger>
            <TabsTrigger value="salary" disabled={loading}>完整薪資記錄匯入</TabsTrigger>
          </TabsList>

          <TabsContent value="attendance" className="mt-4">
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                <p>匯入員工考勤打卡記錄，需包含以下欄位：</p>
                <ul className="list-disc list-inside mt-2 ml-4">
                  <li>日期 (格式: YYYY/MM/DD)</li>
                  <li>上班時間 (格式: HH:MM)</li>
                  <li>下班時間 (格式: HH:MM)</li>
                  <li>是否假日 (選填, 值為「是」或「否」)</li>
                </ul>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="salary" className="mt-4">
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground">
                <p>支援系統匯出的封存薪資快照 CSV，以及舊版中文欄位與「考勤詳細記錄」格式。此流程只新增所選員工尚未結算月份的薪資紀錄，保留檔案內的薪資與出勤資料。</p>
                <p className="mt-2">CSV 的員工必須與所選員工一致。「Record ID」是封存來源參考，會保留在 CSV 中；匯入時由系統建立新紀錄，請勿改寫 ID 來繞過保護。</p>
                <p className="mt-2 font-semibold">已存在的結算紀錄不能以 CSV 覆寫，帶更正修訂的快照也不能重新匯入。請到歷史薪資使用更正預覽，確認影響與差額後再保存。</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="salary-import-employee">匯入員工（必選）</Label>
                <select id="salary-import-employee" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={targetValue} disabled={loading} onChange={(event) => setTargetValue(event.target.value)}>
                  <option value="">請選擇員工</option>
                  {activeEmployees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}
                </select>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="mt-4">
          <div className="flex flex-col items-center justify-center border-2 border-dashed rounded-md p-6">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="hidden"
              disabled={loading}
            />
            <div className="flex flex-col items-center mb-4">
              <FileText className="h-10 w-10 text-primary mb-2" />
              <p className="text-sm text-muted-foreground">
                {file ? file.name : "選擇或拖放 CSV 檔案"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {file ? `檔案大小: ${(file.size / 1024).toFixed(1)} KB` : "支援 .csv 檔案"}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 處理中...
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" /> 選擇檔案
                </>
              )}
            </Button>
          </div>

          {parseResult && (
            <div className={`mt-4 p-3 rounded-md ${parseResult.success ? 'bg-green-50' : 'bg-red-50'}`}>
              <div className="flex items-start">
                {parseResult.success ? (
                  <Check className="h-5 w-5 text-green-600 mr-2 mt-0.5" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-red-600 mr-2 mt-0.5" />
                )}
                <div>
                  <p className={`text-sm font-medium ${parseResult.success ? 'text-green-800' : 'text-red-800'}`}>
                    {parseResult.message}
                  </p>
                  {parseResult.success && parseResult.preview && (
                    <div className="mt-2 text-xs">
                      <p className="font-medium text-gray-700 mb-1">預覽:</p>
                      <div className="max-h-32 overflow-auto border border-gray-200 rounded">
                        <table className="min-w-full">
                          <tbody>
                            {parseResult.preview.map((row, rowIndex) => (
                              <tr key={rowIndex} className={rowIndex === 0 ? 'bg-gray-100' : ''}>
                                {Array.isArray(row) && row.map((cell, cellIndex) => (
                                  <td key={cellIndex} className="px-2 py-1 text-xs truncate max-w-[100px]">
                                    {cell}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={loading}
          >
            取消
          </Button>
          <Button
            onClick={handleImport}
            disabled={loading || !file || !parseResult?.success || (activeTab === 'salary' && !target)}
          >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            匯入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
