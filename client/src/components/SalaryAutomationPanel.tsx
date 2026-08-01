import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mail,
  RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  buildSalaryAutomationRunRequest,
  formatSalaryMonth,
  type SalaryMonthTarget,
} from "@/lib/salaryAutomation";

interface SalaryAutomationConfigSummary {
  timeZone: string;
  smtpConfigured: boolean;
  emailRecipients: string[];
  previousTarget: SalaryMonthTarget;
}

interface SalaryAutomationRunResult {
  target: SalaryMonthTarget;
  status: "succeeded" | "skipped" | "failed" | "dry-run";
  reason?: string;
  persistedRecords: unknown[];
  emailRecipients: string[];
}

interface SalaryAutomationPanelProps {
  hasUnsavedSettings: boolean;
}

function isSalaryAutomationRunResult(
  value: unknown,
): value is SalaryAutomationRunResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<SalaryAutomationRunResult>;
  return (
    !!result.target &&
    Number.isInteger(result.target.year) &&
    Number.isInteger(result.target.month) &&
    ["succeeded", "skipped", "failed", "dry-run"].includes(
      result.status ?? "",
    ) &&
    Array.isArray(result.persistedRecords) &&
    Array.isArray(result.emailRecipients)
  );
}

function getUnsentMessage(result: SalaryAutomationRunResult): string {
  if (result.reason === "no salary records were generated") {
    return "該月份沒有可產生的薪資紀錄，因此未寄送 Email。";
  }

  return "薪資結算或寄信未完成，請檢查系統設定後再試。";
}

export default function SalaryAutomationPanel({
  hasUnsavedSettings,
}: SalaryAutomationPanelProps) {
  const { toast } = useToast();
  const [config, setConfig] = useState<SalaryAutomationConfigSummary | null>(null);
  const [isCheckingConfig, setIsCheckingConfig] = useState(true);
  const [configError, setConfigError] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<SalaryMonthTarget | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [lastResult, setLastResult] = useState<SalaryAutomationRunResult | null>(null);

  const loadConfig = async () => {
    setIsCheckingConfig(true);
    setConfigError(false);

    try {
      const response = await apiRequest("GET", "/api/salary-automation/config");
      const data = (await response.json()) as Partial<SalaryAutomationConfigSummary>;
      if (
        typeof data.timeZone !== "string" ||
        typeof data.smtpConfigured !== "boolean" ||
        !Array.isArray(data.emailRecipients) ||
        !data.previousTarget ||
        !Number.isInteger(data.previousTarget.year) ||
        !Number.isInteger(data.previousTarget.month)
      ) {
        throw new Error("Invalid salary automation configuration response");
      }
      setConfig({
        timeZone: data.timeZone,
        smtpConfigured: data.smtpConfigured,
        emailRecipients: data.emailRecipients,
        previousTarget: data.previousTarget,
      });
    } catch {
      setConfig(null);
      setConfigError(true);
    } finally {
      setIsCheckingConfig(false);
    }
  };

  useEffect(() => {
    void loadConfig();
    // Only check when this admin-only panel mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const previewTarget = config?.previousTarget ?? null;
  const target = pendingTarget ?? previewTarget;
  const recipientCount = config?.emailRecipients.length ?? 0;
  const emailReady = Boolean(config?.smtpConfigured && recipientCount > 0);

  const openConfirmation = () => {
    if (!previewTarget) return;
    setPendingTarget(previewTarget);
    setConfirmOpen(true);
  };

  const handleRun = async () => {
    if (!pendingTarget || !emailReady || hasUnsavedSettings) return;

    setIsRunning(true);
    setLastResult(null);

    try {
      const response = await apiRequest(
        "POST",
        "/api/salary-automation/run",
        buildSalaryAutomationRunRequest(pendingTarget),
      );
      const result = (await response.json()) as unknown;
      if (!isSalaryAutomationRunResult(result)) {
        throw new Error("Invalid salary automation run response");
      }
      setLastResult(result);
      setConfirmOpen(false);
      setPendingTarget(null);

      if (result.status === "succeeded") {
        toast({
          title: "薪資結算與 Email 寄送完成",
          description: `${formatSalaryMonth(result.target)}已更新 ${result.persistedRecords.length} 筆薪資，並寄送給 ${result.emailRecipients.length} 位收件人。`,
        });
      } else {
        toast({
          title: "Email 未寄出",
          description: getUnsentMessage(result),
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "執行結果無法確認",
        description:
          "請先檢查月結紀錄與收件匣，確認未寄出後再操作，請勿立即重複寄送。",
        variant: "destructive",
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <>
      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <Mail className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-medium">薪資月結 Email</h4>
              <p className="text-xs leading-relaxed text-gray-500">
                重新計算上個月薪資、覆寫既有月結紀錄、重產 PDF，並寄送 Email。
              </p>
            </div>
          </div>

          <Button
            type="button"
            className="h-11 w-full rounded-xl sm:w-auto"
            onClick={openConfirmation}
            disabled={
              isCheckingConfig || !emailReady || isRunning || hasUnsavedSettings
            }
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            重新結算並寄送 Email
          </Button>
        </div>

        {hasUnsavedSettings && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            請先儲存上方的薪資設定，再重新結算與寄送，避免套用舊設定。
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs text-slate-500">
              本次目標月份（{config?.timeZone ?? "伺服器時區"}）
            </p>
            <p className="mt-1 font-semibold text-slate-800">
              {previewTarget ? formatSalaryMonth(previewTarget) : "正在確認…"}
            </p>
          </div>

          <div
            className="rounded-lg border border-slate-200 bg-slate-50 p-3"
            aria-live="polite"
          >
            <p className="text-xs text-slate-500">Email 寄送設定</p>
            {isCheckingConfig ? (
              <p className="mt-1 flex items-center gap-2 text-sm text-slate-700">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                正在確認設定…
              </p>
            ) : emailReady ? (
              <p className="mt-1 flex items-center gap-2 text-sm font-medium text-green-700">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                已設定 {recipientCount} 位收件人
              </p>
            ) : (
              <div className="mt-1 flex flex-col items-start gap-2">
                <p className="flex items-center gap-2 text-sm font-medium text-amber-700">
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  {configError ? "無法確認寄信設定" : "寄信設定尚未完成"}
                </p>
                {configError && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadConfig()}
                  >
                    重新檢查
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {lastResult && (
          <div
            className={`mt-4 rounded-lg border p-3 text-sm ${
              lastResult.status === "succeeded"
                ? "border-green-200 bg-green-50 text-green-800"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
            role="status"
          >
            {lastResult.status === "succeeded" ? (
              <span>
                {formatSalaryMonth(lastResult.target)}已完成：更新{" "}
                {lastResult.persistedRecords.length} 筆薪資，寄送給{" "}
                {lastResult.emailRecipients.length} 位收件人。
              </span>
            ) : (
              getUnsentMessage(lastResult)
            )}
          </div>
        )}
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!isRunning) {
            setConfirmOpen(open);
            if (!open) setPendingTarget(null);
          }
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md p-5 sm:max-w-md sm:p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle
                className="h-5 w-5 text-amber-600"
                aria-hidden="true"
              />
              確認重新結算並寄送
            </DialogTitle>
            <DialogDescription className="leading-relaxed">
              此操作會重新計算並覆寫下列月份的薪資紀錄、重新產生 PDF，接著寄送 Email 給已設定的收件人。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 text-center">
              <p className="text-xs font-medium text-amber-700">確認目標月份</p>
              <p className="mt-1 text-xl font-bold text-amber-950">
                {target ? formatSalaryMonth(target) : "正在確認…"}
              </p>
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              預計寄送給 {recipientCount}
              位收件人。執行完成前請勿關閉此頁面或重複操作。
            </p>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full sm:w-auto"
              onClick={() => {
                setConfirmOpen(false);
                setPendingTarget(null);
              }}
              disabled={isRunning}
            >
              取消
            </Button>
            <Button
              type="button"
              className="h-11 w-full bg-amber-600 text-white hover:bg-amber-700 sm:w-auto"
              onClick={() => void handleRun()}
              disabled={isRunning || !emailReady || hasUnsavedSettings}
            >
              {isRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Mail className="h-4 w-4" aria-hidden="true" />
              )}
              {isRunning ? "重新結算與寄送中…" : "確認重新結算並寄送"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
