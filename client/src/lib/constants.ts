/**
 * 全局常量定義
 * 確保前端計算使用與後端一致的數值
 */

// 導入共享常量
import { constants as sharedConstants } from '@shared/constants';

// 擴展共享常量，添加客戶端特有的常量
export const constants = {
  ...sharedConstants,

  // PostgreSQL 連接通過後端處理，前端不需要直接數據庫連接
  // 已遷移到純 PostgreSQL 方案，移除 Supabase API 依賴

  // 客戶端特有常量可在此處添加
  UI_UPDATE_INTERVAL: 60000,  // UI自動更新間隔（毫秒）
  TOAST_DURATION: 5000,      // 提示訊息顯示時間（毫秒）
};