#!/bin/bash

# 員工薪資計算系統 - 完整打包腳本
# 此腳本將收集所有必要檔案並創建部署包

set -e

PACKAGE_NAME="employee-salary-system-complete"
PACKAGE_DATE=$(date +%Y%m%d_%H%M%S)
PACKAGE_DIR="${PACKAGE_NAME}_${PACKAGE_DATE}"
ARCHIVE_NAME="${PACKAGE_DIR}.tar.gz"

echo "=== 員工薪資計算系統 - 打包開始 ==="
echo "打包時間: $(date)"
echo "打包目錄: $PACKAGE_DIR"

# 創建打包目錄
mkdir -p "$PACKAGE_DIR"

echo "正在收集檔案..."

# 1. 複製核心應用程式檔案
echo "- 複製應用程式核心檔案"
cp -r client "$PACKAGE_DIR/"
cp -r server "$PACKAGE_DIR/"
cp -r shared "$PACKAGE_DIR/"

# 2. 複製配置檔案
echo "- 複製配置檔案"
cp package.json "$PACKAGE_DIR/"
cp package-lock.json "$PACKAGE_DIR/" 2>/dev/null || echo "  (package-lock.json 不存在)"
cp tsconfig.json "$PACKAGE_DIR/"
cp vite.config.ts "$PACKAGE_DIR/"
cp tailwind.config.ts "$PACKAGE_DIR/"
cp postcss.config.js "$PACKAGE_DIR/"
cp drizzle.config.ts "$PACKAGE_DIR/"
cp .env.example "$PACKAGE_DIR/"

# 3. 複製主題和樣式檔案
echo "- 複製主題檔案"
cp theme.json "$PACKAGE_DIR/" 2>/dev/null || echo "  (theme.json 不存在)"
cp replit.nix "$PACKAGE_DIR/" 2>/dev/null || echo "  (replit.nix 不存在)"

# 4. 複製文檔目錄
echo "- 複製完整文檔"
cp -r docs "$PACKAGE_DIR/"

# 5. 複製說明檔案
echo "- 複製說明檔案"
cp DEPLOYMENT_PACKAGE_README.md "$PACKAGE_DIR/README.md"
cp SYSTEM_ARCHITECTURE.md "$PACKAGE_DIR/" 2>/dev/null || echo "  (SYSTEM_ARCHITECTURE.md 不存在)"
cp SUPABASE_USAGE.md "$PACKAGE_DIR/" 2>/dev/null || echo "  (SUPABASE_USAGE.md 不存在)"

# 6. 複製重要的輔助腳本
echo "- 複製輔助腳本"
mkdir -p "$PACKAGE_DIR/scripts"

# 複製所有 .js 腳本檔案（如果存在）
for script_file in *.js; do
    if [[ -f "$script_file" && "$script_file" != "package-for-deployment.js" ]]; then
        cp "$script_file" "$PACKAGE_DIR/scripts/"
    fi
done

# 複製特定的重要腳本
cp auto-recovery.js "$PACKAGE_DIR/scripts/" 2>/dev/null || echo "  (auto-recovery.js 不存在)"
cp setup-db.js "$PACKAGE_DIR/scripts/" 2>/dev/null || echo "  (setup-db.js 不存在)"
cp integrity-check.js "$PACKAGE_DIR/scripts/" 2>/dev/null || echo "  (integrity-check.js 不存在)"

# 7. 創建部署腳本
echo "- 創建部署腳本"
cat > "$PACKAGE_DIR/deploy.sh" << 'EOF'
#!/bin/bash

# 員工薪資計算系統 - 快速部署腳本

echo "=== 員工薪資計算系統部署 ==="

# 檢查 Node.js
if ! command -v node &> /dev/null; then
    echo "錯誤: Node.js 未安裝，請先安裝 Node.js 18 或更新版本"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "錯誤: Node.js 版本過舊，需要 18 或更新版本"
    exit 1
fi

echo "✓ Node.js 版本檢查通過"

# 安裝相依套件
echo "正在安裝相依套件..."
npm install

if [ $? -eq 0 ]; then
    echo "✓ 相依套件安裝成功"
else
    echo "✗ 相依套件安裝失敗"
    exit 1
fi

# 檢查環境變數
if [ ! -f .env ]; then
    echo "警告: .env 檔案不存在"
    echo "請複製 .env.example 為 .env 並填入正確的設定值"
    echo ""
    echo "基本設定步驟："
    echo "1. cp .env.example .env"
    echo "2. 編輯 .env 檔案，填入資料庫連接資訊"
    echo "3. 重新執行此腳本"
    exit 1
fi

echo "✓ 環境變數檔案存在"

# 測試資料庫連接
echo "正在測試資料庫連接..."
npm run db:check

if [ $? -eq 0 ]; then
    echo "✓ 資料庫連接成功"
else
    echo "✗ 資料庫連接失敗，請檢查 .env 中的 DATABASE_URL 設定"
    exit 1
fi

# 推送資料庫結構
echo "正在初始化資料庫結構..."
npm run db:push

if [ $? -eq 0 ]; then
    echo "✓ 資料庫結構初始化成功"
else
    echo "✗ 資料庫結構初始化失敗"
    exit 1
fi

# 建置前端
echo "正在建置前端..."
npm run build

if [ $? -eq 0 ]; then
    echo "✓ 前端建置成功"
else
    echo "✗ 前端建置失敗"
    exit 1
fi

echo ""
echo "=== 部署完成 ==="
echo ""
echo "啟動應用程式："
echo "  開發模式: npm run dev"
echo "  生產模式: npm start"
echo ""
echo "瀏覽器訪問: http://localhost:5000"
echo ""
echo "更多資訊請參閱："
echo "  - README.md (快速開始)"
echo "  - docs/INSTALLATION.md (詳細安裝指南)"
echo "  - docs/CONFIGURATION.md (系統配置)"
EOF

chmod +x "$PACKAGE_DIR/deploy.sh"

# 8. 創建快速啟動腳本
echo "- 創建快速啟動腳本"
cat > "$PACKAGE_DIR/start.sh" << 'EOF'
#!/bin/bash

# 快速啟動腳本

if [ ! -f .env ]; then
    echo "錯誤: .env 檔案不存在，請先執行 ./deploy.sh"
    exit 1
fi

echo "啟動員工薪資計算系統..."

# 檢查是否已建置
if [ ! -d "client/dist" ]; then
    echo "正在建置前端..."
    npm run build
fi

# 啟動應用程式
npm start
EOF

chmod +x "$PACKAGE_DIR/start.sh"

# 9. 創建開發啟動腳本
echo "- 創建開發模式啟動腳本"
cat > "$PACKAGE_DIR/dev.sh" << 'EOF'
#!/bin/bash

# 開發模式啟動腳本

if [ ! -f .env ]; then
    echo "錯誤: .env 檔案不存在，請先執行 ./deploy.sh"
    exit 1
fi

echo "啟動開發模式..."
npm run dev
EOF

chmod +x "$PACKAGE_DIR/dev.sh"

# 10. 創建資料庫管理腳本
echo "- 創建資料庫管理腳本"
cat > "$PACKAGE_DIR/db-manage.sh" << 'EOF'
#!/bin/bash

# 資料庫管理腳本

case "$1" in
    "check")
        echo "檢查資料庫連接..."
        npm run db:check
        ;;
    "push")
        echo "推送資料庫結構..."
        npm run db:push
        ;;
    "reset")
        echo "重置資料庫..."
        npm run db:reset
        ;;
    "backup")
        echo "創建資料庫備份..."
        node scripts/backup-create.js
        ;;
    *)
        echo "用法: $0 {check|push|reset|backup}"
        echo ""
        echo "  check  - 檢查資料庫連接"
        echo "  push   - 推送資料庫結構"
        echo "  reset  - 重置資料庫"
        echo "  backup - 創建備份"
        ;;
esac
EOF

chmod +x "$PACKAGE_DIR/db-manage.sh"

# 11. 創建系統監控腳本
echo "- 創建系統監控腳本"
cat > "$PACKAGE_DIR/monitor.sh" << 'EOF'
#!/bin/bash

# 系統監控腳本

echo "=== 員工薪資計算系統狀態 ==="
echo "時間: $(date)"
echo ""

# 檢查程序狀態
if pgrep -f "node.*server" > /dev/null; then
    echo "✓ 應用程式運行中"
    PID=$(pgrep -f "node.*server")
    echo "  程序 ID: $PID"
else
    echo "✗ 應用程式未運行"
fi

# 檢查端口
if netstat -tlnp 2>/dev/null | grep ":5000 " > /dev/null; then
    echo "✓ 端口 5000 開放"
else
    echo "✗ 端口 5000 未開放"
fi

# 檢查資料庫連接
echo ""
echo "檢查資料庫連接..."
npm run db:check 2>/dev/null

# 檢查磁碟空間
echo ""
echo "磁碟使用狀況:"
df -h / | tail -1

# 檢查記憶體使用
echo ""
echo "記憶體使用狀況:"
free -h | grep Mem

echo ""
echo "=== 監控完成 ==="
EOF

chmod +x "$PACKAGE_DIR/monitor.sh"

# 12. 創建版本資訊檔案
echo "- 創建版本資訊"
cat > "$PACKAGE_DIR/VERSION.md" << EOF
# 員工薪資計算系統版本資訊

## 版本詳情

- **版本號**: 1.0.0
- **建置日期**: $(date)
- **打包日期**: $(date)
- **Node.js 要求**: 18.0.0+
- **資料庫**: PostgreSQL 13+ / Supabase

## 系統功能

### 核心功能
- ✅ 員工資料管理
- ✅ 條碼掃描打卡
- ✅ 考勤記錄管理
- ✅ 薪資自動計算
- ✅ 加班費計算（按日累計）
- ✅ 勞健保扣款
- ✅ 報表生成與匯出

### 技術特性
- ✅ TypeScript 全程式
- ✅ React + Vite 前端
- ✅ Express.js 後端
- ✅ Drizzle ORM
- ✅ PostgreSQL/Supabase 支援
- ✅ 即時數據同步
- ✅ 響應式設計
- ✅ 資料加密保護

### 系統特色
- ✅ 精確的薪資計算
- ✅ 符合勞動法規的加班費計算
- ✅ 直觀的使用者介面
- ✅ 完整的備份機制
- ✅ 詳細的系統監控

## 更新記錄

### v1.0.0 ($(date +%Y-%m-%d))
- 初始發布版本
- 完整的員工薪資計算功能
- 條碼掃描打卡系統
- 詳細的部署文檔
- 完整的技術支援指南

## 系統需求

### 最低要求
- CPU: 雙核心 2GHz
- 記憶體: 2GB RAM
- 儲存空間: 10GB
- 網路: 寬頻連接

### 建議配置
- CPU: 四核心 2.5GHz+
- 記憶體: 4GB+ RAM
- 儲存空間: 20GB+ SSD
- 網路: 穩定寬頻連接

## 相容性

### 作業系統
- Ubuntu 20.04+ (推薦)
- CentOS 8+
- Windows Server 2019+
- macOS 11.0+

### 瀏覽器
- Chrome 90+
- Firefox 90+
- Safari 14+
- Edge 90+

## 授權資訊

本軟體包含完整原始碼，可依據需求進行客製化修改。

## 技術支援

詳細技術支援資訊請參閱 docs/SUPPORT.md 檔案。
EOF

# 13. 創建 .gitignore 檔案
echo "- 創建 .gitignore"
cat > "$PACKAGE_DIR/.gitignore" << 'EOF'
# 相依套件
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# 環境變數
.env
.env.local
.env.production

# 建置輸出
dist/
build/
client/dist/

# 日誌檔案
logs/
*.log
*.log.*

# 暫存檔案
.tmp/
temp/
*.tmp

# 編輯器檔案
.vscode/
.idea/
*.swp
*.swo
*~

# 作業系統檔案
.DS_Store
Thumbs.db

# 備份檔案
backups/
*.backup
*.bak

# 資料庫檔案
*.sqlite
*.db

# 快取檔案
.cache/
.npm/
.eslintcache

# 測試覆蓋率
coverage/
.nyc_output/

# 專案特定忽略
data/
uploads/
sessions/
EOF

# 14. 創建完整的檔案清單
echo "- 創建檔案清單"
find "$PACKAGE_DIR" -type f | sort > "$PACKAGE_DIR/FILES.txt"

# 15. 計算檔案統計
echo "- 計算統計資訊"
FILE_COUNT=$(find "$PACKAGE_DIR" -type f | wc -l)
TOTAL_SIZE=$(du -sh "$PACKAGE_DIR" | cut -f1)

# 16. 創建安裝檢查清單
echo "- 創建安裝檢查清單"
cat > "$PACKAGE_DIR/INSTALLATION_CHECKLIST.md" << EOF
# 安裝檢查清單

在開始安裝前，請確認以下項目：

## 系統準備

- [ ] 作業系統符合需求 (Ubuntu 20.04+ / CentOS 8+ / Windows Server 2019+)
- [ ] 已安裝 Node.js 18.0.0 或更新版本
- [ ] 已安裝 npm 8.0.0 或更新版本
- [ ] 系統有足夠的磁碟空間 (最少 10GB)
- [ ] 系統有足夠的記憶體 (最少 2GB)
- [ ] 網路連接正常

## 資料庫準備

選擇以下其中一種方式：

### 選項 A: Supabase (推薦)
- [ ] 已註冊 Supabase 帳號
- [ ] 已創建新專案
- [ ] 已獲取專案 URL 和 API 金鑰
- [ ] 已獲取資料庫連接字串

### 選項 B: 本地 PostgreSQL
- [ ] 已安裝 PostgreSQL 13 或更新版本
- [ ] 已創建資料庫和使用者
- [ ] 已測試資料庫連接
- [ ] 已配置防火牆規則

## 安裝步驟

- [ ] 1. 解壓專案檔案
- [ ] 2. 進入專案目錄
- [ ] 3. 複製 .env.example 為 .env
- [ ] 4. 編輯 .env 檔案，填入設定值
- [ ] 5. 執行 ./deploy.sh 部署腳本
- [ ] 6. 等待安裝完成
- [ ] 7. 執行 ./start.sh 啟動系統

## 驗證檢查

- [ ] 應用程式成功啟動
- [ ] 可以通過瀏覽器訪問 http://localhost:5000
- [ ] 資料庫連接正常
- [ ] 管理員登入功能正常
- [ ] 基本功能測試通過

## 安全設置

- [ ] 已修改預設管理員密碼
- [ ] 已設置強密碼政策
- [ ] 已配置防火牆
- [ ] 已設置 SSL 憑證 (生產環境)
- [ ] 已配置定期備份

## 完成後檢查

- [ ] 系統運行穩定
- [ ] 所有功能正常
- [ ] 效能符合期望
- [ ] 備份機制運作正常
- [ ] 監控系統設置完成

如有任何問題，請參閱相關文檔或聯絡技術支援。
EOF

# 壓縮打包
echo "正在壓縮打包..."
tar -czf "$ARCHIVE_NAME" "$PACKAGE_DIR"

# 生成 MD5 檢查碼
echo "正在生成檢查碼..."
if command -v md5sum &> /dev/null; then
    md5sum "$ARCHIVE_NAME" > "${ARCHIVE_NAME}.md5"
elif command -v md5 &> /dev/null; then
    md5 "$ARCHIVE_NAME" > "${ARCHIVE_NAME}.md5"
fi

# 計算最終大小
ARCHIVE_SIZE=$(ls -lh "$ARCHIVE_NAME" | awk '{print $5}')

# 清理臨時目錄
rm -rf "$PACKAGE_DIR"

echo ""
echo "=== 打包完成 ==="
echo ""
echo "打包檔案: $ARCHIVE_NAME"
echo "檔案大小: $ARCHIVE_SIZE"
echo "包含檔案: $FILE_COUNT 個"
echo "專案大小: $TOTAL_SIZE"
echo ""
echo "檔案包含:"
echo "  ✓ 完整原始碼 (前端、後端、共用模組)"
echo "  ✓ 設定檔案與範本"
echo "  ✓ 完整技術文檔 (安裝、配置、API、故障排除)"
echo "  ✓ 部署與管理腳本"
echo "  ✓ 系統監控工具"
echo "  ✓ 備份與恢復工具"
echo ""
echo "部署指南:"
echo "  1. 將 $ARCHIVE_NAME 傳送到目標伺服器"
echo "  2. 解壓: tar -xzf $ARCHIVE_NAME"
echo "  3. 進入目錄: cd $PACKAGE_DIR"
echo "  4. 執行部署: ./deploy.sh"
echo "  5. 啟動系統: ./start.sh"
echo ""
echo "詳細說明請參閱解壓後的 README.md 檔案"
echo ""
echo "=== 打包程序結束 ==="
EOF

chmod +x package-for-deployment.sh

echo "打包腳本已創建完成。現在執行打包程序..."

# 執行打包腳本
<function_calls>
<invoke name="bash">
<parameter name="command">./package-for-deployment.sh