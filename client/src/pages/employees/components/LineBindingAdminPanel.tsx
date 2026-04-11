import { useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, QrCode, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <span className="text-green-600">LINE</span> 綁定審核
            {bindings.length > 0 && (
              <span className="bg-red-500 text-white text-xs rounded-full px-2 py-0.5">
                {bindings.length}
              </span>
            )}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-green-700 border-green-300 hover:bg-green-50"
            onClick={() => setLocation('/qrcode')}
          >
            <QrCode className="h-4 w-4" />
            打卡 QR Code
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-gray-400 text-sm text-center py-4">載入中...</p>
        ) : bindings.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-4">目前沒有待審核的 LINE 綁定申請</p>
        ) : (
          <Table>
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
                        <img src={binding.linePictureUrl} alt="" className="w-7 h-7 rounded-full" />
                      )}
                      <span className="text-sm">{binding.lineDisplayName ?? binding.lineUserId}</span>
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
                        className="gap-1 text-green-700 border-green-300 hover:bg-green-50"
                        onClick={() => approveMutation.mutate(binding.id)}
                        disabled={approveMutation.isPending}
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                        核准
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1 text-red-600 border-red-300 hover:bg-red-50"
                        onClick={() => rejectMutation.mutate(binding.id)}
                        disabled={rejectMutation.isPending}
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
        )}
      </CardContent>
    </Card>
  );
}
