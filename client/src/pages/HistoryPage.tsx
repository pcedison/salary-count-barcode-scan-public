import { useEffect, useRef, useState } from 'react';
import { Archive, Loader2, Lock, Shield, Upload } from 'lucide-react';
import JSZip from 'jszip';
import { useHistoryData, type SalaryRecord } from '@/hooks/useHistoryData';
import { useAdmin } from '@/hooks/useAdmin';
import { useEmployees } from '@/hooks/useEmployees';
import { useToast } from '@/hooks/use-toast';
import HistoryTable from '@/components/HistoryTable';
import ConfirmationModal from '@/components/ConfirmationModal';
import AdminLoginDialog from '@/components/AdminLoginDialog';
import EditHistoryRecordModal from '@/components/EditHistoryRecordModal';
import HolidayCorrectionModal from '@/components/HolidayCorrectionModal';
import { CsvImportModal } from '@/components/CsvImportModal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { buildAttendanceCsv, buildSalaryRecordCsv, salaryRecordFileName } from '@/lib/historyExport';
import { correctionErrorMessage } from '@/lib/holidayCorrection';

export default function HistoryPage() {
  const { toast } = useToast();
  const { isAdmin } = useAdmin();
  const { activeEmployees } = useEmployees();
  const [searchTerm, setSearchTerm] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ search: '', year: '', employeeId: '' });
  const [currentPage, setCurrentPage] = useState(1);
  const [recordToDelete, setRecordToDelete] = useState<number | null>(null);
  const [recordToEdit, setRecordToEdit] = useState<SalaryRecord | null>(null);
  const [recordToCorrect, setRecordToCorrect] = useState<number | null>(null);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [selectedRecordIds, setSelectedRecordIds] = useState<number[]>([]);
  const [isExportingZip, setIsExportingZip] = useState(false);
  const [loadingEditId, setLoadingEditId] = useState<number | null>(null);
  const exporting = useRef(false);
  const editing = useRef(false);
  const correctionTrigger = useRef<HTMLElement | null>(null);
  const {
    salaryRecords, pagination, isLoading, isFetching, error, refetch, refreshSalaryQueries,
    deleteSalaryRecord, updateSalaryRecord, getSalaryRecordById, exportSalaryRecordAsCsv,
    isDeletingRecord, isUpdatingRecord,
  } = useHistoryData({ page: currentPage, limit: 10, ...appliedFilters });

  useEffect(() => { setSelectedRecordIds([]); }, [currentPage, appliedFilters]);
  useEffect(() => {
    if (pagination.pages > 0 && currentPage > pagination.pages) setCurrentPage(pagination.pages);
  }, [pagination.pages, currentPage]);
  const handleEditClick = async (record: Pick<SalaryRecord, 'id'>) => {
    if (!isAdmin || editing.current) return;
    editing.current = true;
    setLoadingEditId(record.id);
    try { setRecordToEdit(await getSalaryRecordById(record.id)); }
    catch (err) { toast({ title: '讀取失敗', description: correctionErrorMessage(err), variant: 'destructive' }); }
    finally { editing.current = false; setLoadingEditId(null); }
  };
  const handleSaveEditedRecord = async (id: number, updatedData: Record<string, unknown>) => {
    await updateSalaryRecord(id, updatedData);
    toast({ title: '更正已保存', description: '已保存金額修訂與差額紀錄，系統未付款或通知員工。' });
    setRecordToEdit(null);
  };
  const handleConfirmDelete = async () => {
    if (recordToDelete === null) return;
    try {
      await deleteSalaryRecord(recordToDelete);
      setRecordToDelete(null);
      setSelectedRecordIds([]);
      if (salaryRecords.length === 1 && currentPage > 1) setCurrentPage((page) => page - 1);
    } catch (err) { toast({ title: '刪除失敗', description: correctionErrorMessage(err), variant: 'destructive' }); }
  };
  const handleBatchDownloadAsZip = async () => {
    if (!selectedRecordIds.length || exporting.current) return;
    exporting.current = true;
    setIsExportingZip(true);
    try {
      // Selection is limited to this page. Read current committed snapshots before export.
      const records = await Promise.all(selectedRecordIds.map((id) => getSalaryRecordById(id)));
      const zip = new JSZip();
      for (const record of records) {
        zip.file(salaryRecordFileName(record, 'attendance'), buildAttendanceCsv(record));
        zip.file(salaryRecordFileName(record), buildSalaryRecordCsv(record));
      }
      const zipContent = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipContent);
      const link = document.createElement('a');
      link.href = url;
      link.download = `salary-records_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
      toast({ title: '匯出成功', description: `已匯出 ${records.length} 筆最新薪資結算紀錄。` });
    } catch { toast({ title: '匯出失敗', description: '無法讀取全部選取的薪資紀錄，請重新載入後再試。', variant: 'destructive' }); }
    finally { exporting.current = false; setIsExportingZip(false); }
  };

  if (!isAdmin) return <div className="page-stack">
    <h2 className="page-title">歷史薪資紀錄</h2>
    <div className="page-panel mx-auto max-w-2xl text-center sm:p-12">
      <Lock className="mx-auto mb-6 h-14 w-14 text-primary" />
      <h3 className="mb-4 text-2xl font-bold">需要管理員權限</h3>
      <p className="mb-6 text-gray-600">歷史薪資包含員工敏感資料，請登入管理員帳號以查看。</p>
      <Button onClick={() => setIsLoginModalOpen(true)}><Shield className="mr-2 h-4 w-4" />管理員登入</Button>
    </div>
    <AdminLoginDialog isOpen={isLoginModalOpen} onClose={() => setIsLoginModalOpen(false)} onSuccess={() => setIsLoginModalOpen(false)} title="管理員登入" description="請輸入管理員 PIN 碼以查看歷史薪資。" />
  </div>;

  const start = pagination.total ? (pagination.page - 1) * pagination.limit + 1 : 0;
  return <div className="page-stack">
    <div className="page-panel-muted page-header">
      <h2 className="page-title">歷史薪資紀錄</h2>
      <span className="flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-sm text-primary"><Shield className="h-4 w-4" />管理員模式</span>
    </div>
    <p className="text-sm text-muted-foreground">補登或更正已結算的假日，請使用各筆紀錄的「假日更正」，核對預覽與差額後確認。</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => setIsImportModalOpen(true)}><Upload className="mr-1 h-4 w-4" />匯入 CSV</Button>
      <Button variant="outline" size="sm" onClick={() => void handleBatchDownloadAsZip()} disabled={isExportingZip || !selectedRecordIds.length}><Archive className="mr-1 h-4 w-4" />{isExportingZip ? '匯出中…' : '下載本頁選取 ZIP'}</Button>
      <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>重新載入</Button>
      {loadingEditId !== null && <span role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />讀取最新紀錄…</span>}
    </div>
    <form className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_8rem_12rem_auto]" onSubmit={(event) => {
      event.preventDefault(); setCurrentPage(1); setAppliedFilters({ search: searchTerm.trim(), year: yearFilter, employeeId: employeeFilter });
    }}>
      <div className="space-y-1"><Label htmlFor="history-search">搜尋</Label><Input id="history-search" value={searchTerm} maxLength={100} onChange={(event) => setSearchTerm(event.target.value)} placeholder="員工姓名或年月" /></div>
      <div className="space-y-1"><Label htmlFor="history-year">年份</Label><Input id="history-year" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={yearFilter} onChange={(event) => setYearFilter(event.target.value)} placeholder="所有年份" /></div>
      <div className="space-y-1"><Label htmlFor="history-employee">員工</Label><select id="history-employee" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" value={employeeFilter} onChange={(event) => setEmployeeFilter(event.target.value)}><option value="">所有員工</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></div>
      <Button type="submit">套用篩選</Button>
    </form>
    {error ? <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">無法載入歷史紀錄，請重新載入或確認管理員登入。</div> : <HistoryTable
      records={salaryRecords} isLoading={isLoading} isAdmin={isAdmin} isDeleting={isDeletingRecord}
      onDownloadPdf={(record) => void exportSalaryRecordAsCsv(record)}
      onDeleteRecord={(id) => setRecordToDelete(id)} onEditRecord={(record) => void handleEditClick(record)}
      onCorrectHolidays={(record) => { correctionTrigger.current = document.activeElement as HTMLElement; setRecordToCorrect(record.id); }}
      selectedRecords={selectedRecordIds}
      onSelectRecord={(id, checked) => setSelectedRecordIds((ids) => checked ? Array.from(new Set([...ids, id])) : ids.filter((item) => item !== id))}
      onSelectAll={(checked) => setSelectedRecordIds(checked ? salaryRecords.map((record) => record.id) : [])}
    />}
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p aria-live="polite">顯示 {start} – {pagination.total ? start + salaryRecords.length - 1 : 0} 筆，共 {pagination.total} 筆；本頁選取 {selectedRecordIds.length} 筆</p>
      <nav aria-label="歷史薪資分頁" className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={isFetching || currentPage <= 1} onClick={() => setCurrentPage((page) => page - 1)}>上一頁</Button><span>第 {pagination.pages ? currentPage : 0} / {pagination.pages} 頁</span><Button variant="outline" size="sm" disabled={isFetching || currentPage >= pagination.pages} onClick={() => setCurrentPage((page) => page + 1)}>下一頁</Button></nav>
    </div>
    <ConfirmationModal isOpen={recordToDelete !== null} onClose={() => { if (!isDeletingRecord) setRecordToDelete(null); }} onConfirm={handleConfirmDelete} title="刪除薪資紀錄" message="確定刪除此筆結算紀錄嗎？此操作無法復原。" isProcessing={isDeletingRecord} />
    <EditHistoryRecordModal record={recordToEdit} isOpen={recordToEdit !== null} onClose={() => setRecordToEdit(null)} onReload={(id) => void handleEditClick({ id })} onSave={handleSaveEditedRecord} isSaving={isUpdatingRecord} />
    {recordToCorrect !== null && <HolidayCorrectionModal key={recordToCorrect} recordId={recordToCorrect} onSaved={refreshSalaryQueries} onClose={() => { setRecordToCorrect(null); requestAnimationFrame(() => correctionTrigger.current?.focus()); }} />}
    <CsvImportModal open={isImportModalOpen} onOpenChange={setIsImportModalOpen} onImportSuccess={refreshSalaryQueries} />
  </div>;
}
