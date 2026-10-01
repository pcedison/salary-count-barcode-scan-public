import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CsvImportModal } from './CsvImportModal';

vi.mock('@/hooks/useEmployees', () => ({
  useEmployees: () => ({ activeEmployees: [{ id: 7, name: 'Synthetic Employee' }] }),
}));

// Render the actual form content without a portal or selected-tab DOM environment.
// Browser interaction/layout remains a separate desktop/mobile check.
vi.mock('@/components/ui/dialog', async () => {
  const { createElement } = await import('react');
  const content = ({ children }: { children: React.ReactNode }) => createElement('div', null, children);
  return { Dialog: content, DialogContent: content, DialogDescription: content, DialogFooter: content,
    DialogHeader: content, DialogTitle: content };
});
vi.mock('@/components/ui/tabs', async () => {
  const { createElement } = await import('react');
  const content = ({ children }: { children: React.ReactNode }) => createElement('div', null, children);
  return { Tabs: content, TabsContent: content, TabsList: content, TabsTrigger: content };
});

const render = () => renderToStaticMarkup(createElement(CsvImportModal, {
  open: true, onOpenChange: () => undefined, onImportSuccess: () => undefined,
}));

describe('salary CSV import form contract', () => {
  it('offers only an explicit employee selector, with no unusable history-record target', () => {
    const html = render();
    expect(html).toContain('id="salary-import-employee"');
    expect(html).toContain('value="7">Synthetic Employee</option>');
    expect(html).not.toContain('salary-import-target-type');
    expect(html).not.toContain('salary-import-record');
    expect(html).not.toContain('value="record"');
  });

  it('limits the flow to unfinalized months and directs existing records to a correction preview', () => {
    const html = render();
    expect(html).toContain('只新增所選員工尚未結算月份');
    expect(html).toContain('已存在的結算紀錄不能以 CSV 覆寫');
    expect(html).toContain('帶更正修訂的快照也不能重新匯入');
    expect(html).toContain('使用更正預覽，確認影響與差額');
  });

  it('keeps exported record IDs as source references and explains employee matching', () => {
    const html = render();
    expect(html).toContain('CSV 的員工必須與所選員工一致');
    expect(html).toContain('「Record ID」是封存來源參考');
    expect(html).toContain('請勿改寫 ID 來繞過保護');
    expect(html).toContain('舊版中文欄位');
  });
});
