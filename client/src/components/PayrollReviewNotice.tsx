import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  describePayrollReviewFinding,
  isPendingPayrollReviewList,
  type PendingPayrollReview,
} from "@/lib/payrollReview";

/**
 * 月結前檢查發現疑點時，自動月結會暫停並寄信。
 * 這裡列出暫停的月份與疑點；管理員補好考勤後按按鈕，系統才會跑那個月的月結。
 */
export default function PayrollReviewNotice() {
  const { toast } = useToast();
  const [reviews, setReviews] = useState<PendingPayrollReview[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = async () => {
    try {
      const response = await apiRequest("GET", "/api/salary-automation/reviews/pending");
      const data = (await response.json()) as unknown;
      setReviews(isPendingPayrollReviewList(data) ? data : []);
    } catch {
      // 資料表還沒建立或暫時讀不到時，不擋住月結面板其他功能。
      setReviews([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const confirm = async (review: PendingPayrollReview) => {
    const key = `${review.salaryYear}-${review.salaryMonth}`;
    setConfirming(key);
    try {
      const response = await apiRequest("POST", "/api/salary-automation/reviews/confirm", {
        year: review.salaryYear,
        month: review.salaryMonth,
      });
      const data = (await response.json()) as { result?: { status?: string } };
      toast({
        title: `${review.salaryYear}年${review.salaryMonth}月已確認`,
        description:
          data.result?.status === "succeeded"
            ? "月結已完成，薪資 Email 已寄出。"
            : "已確認，但這次月結沒有完成，請看月結紀錄。",
      });
      await load();
    } catch {
      toast({
        title: "確認沒有完成",
        description: "請重新整理頁面，確認月結紀錄後再試，請勿連續重按。",
        variant: "destructive",
      });
    } finally {
      setConfirming(null);
    }
  };

  if (reviews.length === 0) return null;

  return (
    <div className="mb-4 space-y-3">
      {reviews.map((review) => {
        const key = `${review.salaryYear}-${review.salaryMonth}`;
        return (
          <div key={key} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              {review.salaryYear}年{review.salaryMonth}月月結已暫停，有 {review.findings.length} 件要確認
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {review.findings.map((finding, index) => (
                <li key={index}>{describePayrollReviewFinding(finding)}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs">
              請先到「考勤登記」或「假日設定」補好漏登的日子，再按下方按鈕執行月結。
            </p>
            <Button
              type="button"
              className="mt-3 h-11 w-full rounded-xl sm:w-auto"
              onClick={() => void confirm(review)}
              disabled={confirming !== null}
            >
              {confirming === key && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              確認無誤，執行月結
            </Button>
          </div>
        );
      })}
    </div>
  );
}
