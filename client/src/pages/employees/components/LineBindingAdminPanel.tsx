import { useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, QrCode, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAdmin } from '@/hooks/useAdmin';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';

import type { PendingBinding } from '../types';

export function LineBindingAdminPanel() {
  const { toast } = useToast();
  const { isAdmin } = useAdmin();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  const { data: bindings = [], isLoading } = useQuery<PendingBinding[]>({
    queryKey: ['/api/line/pending-bindings'],
    queryFn: async () => {
      const response = await apiRequest('GET', '/api/line/pending-bindings');
      return response.json();
    },
    enabled: isAdmin,
    refetchInterval: 30000,
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiRequest('POST', `/api/line/pending-bindings/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/line/pending-bindings'] });
      toast({ title: '已核准 LINE 綁定' });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest('POST', `/api/line/pending-bindings/${id}/reject`, { reason: '申請未通過審核' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/line/pending-bindings'] });
      toast({ title: '已拒絕 LINE 綁定' });
    },
  });

  if (!isAdmin) {
    return null;
  }

  const isMutating = approveMutation.isPending || rejectMutation.isPending;

  return (
    <Card>
      <CardHeader className="gap-3 px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-lg">
              <span className="text-green-600">LINE</span> 綁定審核
              {bindings.length > 0 && (
                <span className="rounded-full bg-red-500 px-2 py-0.5 text-xs text-white">
                  {bindings.length}
                </span>
              )}
            </CardTitle>
            <CardDescription>手機端可直接審核申請，桌面端保留表格瀏覽效率。</CardDescription>
          </div>
          <Button
            variant="outline"
            className="w-full gap-1 border-green-300 text-green-700 hover:bg-green-50 sm:w-auto"
            onClick={() => setLocation('/qrcode')}
          >
            <QrCode className="h-4 w-4" />
            打卡 QR Code
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
        {isLoading ? (
          <p className="py-8 text-center text-sm text-gray-400">載入中...</p>
        ) : bindings.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">目前沒有待審核的 LINE 綁定申請</p>
        ) : (
          <>
            <div className="space-y-3 md:hidden">
              {bindings.map((binding) => (
                <div key={binding.id} className="rounded-lg border bg-background p-4 shadow-sm">
                  <div className="flex items-start gap-3">
                    {binding.linePictureUrl && (
                      <img src={binding.linePictureUrl} alt="" className="h-10 w-10 shrink-0 rounded-full" />
                    )}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">{binding.employeeName}</p>
                        <span className="rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700">
                          待審核
                        </span>
                      </div>
                      <p className="truncate text-sm">{binding.lineDisplayName ?? binding.lineUserId}</p>
                      {binding.lineDisplayName && (
                        <p className="truncate text-xs text-muted-foreground">{binding.lineUserId}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        申請時間：{binding.requestedAt ? new Date(binding.requestedAt).toLocaleDateString('zh-TW') : '-'}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <Button
                      variant="outline"
                      className="w-full border-green-300 text-green-700 hover:bg-green-50"
                      onClick={() => approveMutation.mutate(binding.id)}
                      disabled={isMutating}
                    >
                      <CheckCircle className="h-4 w-4" />
                      核准
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full border-red-300 text-red-600 hover:bg-red-50"
                      onClick={() => rejectMutation.mutate(binding.id)}
                      disabled={isMutating}
                    >
                      <XCircle className="h-4 w-4" />
                      拒絕
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="hidden md:block">
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>員工</TableHead>
                    <TableHead>LINE 帳號</TableHead>
                    <TableHead>申請時間</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bindings.map((binding) => (
                    <TableRow key={binding.id}>
                      <TableCell className="font-medium">{binding.employeeName}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {binding.linePictureUrl && (
                            <img src={binding.linePictureUrl} alt="" className="h-7 w-7 rounded-full" />
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm">{binding.lineDisplayName ?? binding.lineUserId}</p>
                            {binding.lineDisplayName && (
                              <p className="truncate text-xs text-muted-foreground">{binding.lineUserId}</p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-gray-500">
                        {binding.requestedAt ? new Date(binding.requestedAt).toLocaleDateString('zh-TW') : '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 border-green-300 text-green-700 hover:bg-green-50"
                            onClick={() => approveMutation.mutate(binding.id)}
                            disabled={isMutating}
                          >
                            <CheckCircle className="h-3.5 w-3.5" />
                            核准
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 border-red-300 text-red-600 hover:bg-red-50"
                            onClick={() => rejectMutation.mutate(binding.id)}
                            disabled={isMutating}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            拒絕
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
