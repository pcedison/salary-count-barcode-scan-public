import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from 'lucide-react';

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  isProcessing?: boolean;
}

export default function ConfirmationModal({ isOpen, onClose, onConfirm, title, message, isProcessing = false }: ConfirmationModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex justify-end space-x-3">
          <Button
            variant="outline"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            disabled={isProcessing}
          >
            取消
          </Button>
          <Button
            onClick={onConfirm}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-800 text-white rounded-md border border-slate-500"
            disabled={isProcessing}
          >
            {isProcessing ? (
              <div className="flex items-center">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                處理中...
              </div>
            ) : (
              '確認'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
