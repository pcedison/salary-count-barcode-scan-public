import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAdmin } from "@/hooks/useAdmin";
import { Loader2 } from "lucide-react";

interface AdminLoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  onVerifyPin?: (pin: string) => Promise<boolean>;
  title?: string;
  description?: string;
  pinLabel?: string;
  placeholder?: string;
  submitLabel?: string;
  verifyingLabel?: string;
}

export default function AdminLoginDialog({
  isOpen,
  onClose,
  onSuccess,
  onVerifyPin,
  title = "管理員驗證",
  description = "請輸入 6 位數管理 PIN 以繼續。",
  pinLabel = "管理 PIN",
  placeholder = "請輸入 6 位數 PIN",
  submitLabel = "確認",
  verifyingLabel = "驗證中",
}: AdminLoginDialogProps) {
  const [pin, setPin] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const { verifyPin } = useAdmin();

  useEffect(() => {
    if (!isOpen) {
      setPin("");
      setIsVerifying(false);
    }
  }, [isOpen]);

  const handleVerify = async () => {
    if (pin.length !== 6) {
      return;
    }

    setIsVerifying(true);
    const verifyHandler = onVerifyPin ?? verifyPin;
    const success = await verifyHandler(pin);
    setIsVerifying(false);

    if (success) {
      onSuccess?.();
      onClose();
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      void handleVerify();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-4">
          <div className="flex flex-col space-y-2">
            <label htmlFor="adminPin" className="font-medium">
              {pinLabel}
            </label>
            <Input
              id="adminPin"
              type="password"
              maxLength={6}
              pattern="[0-9]*"
              inputMode="numeric"
              placeholder={placeholder}
              value={pin}
              onChange={(e) => {
                const value = e.target.value.replace(/[^0-9]/g, "");
                if (value.length <= 6) {
                  setPin(value);
                }
              }}
              onKeyDown={handleKeyPress}
              className="w-full"
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isVerifying}>
            取消
          </Button>
          <Button onClick={handleVerify} disabled={pin.length !== 6 || isVerifying}>
            {isVerifying ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {verifyingLabel}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
