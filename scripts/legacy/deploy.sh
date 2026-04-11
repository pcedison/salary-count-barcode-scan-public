#!/bin/bash

# 員工薪資管理系統部署腳本
# 版本: 1.0
# 日期: 2025-06-05

set -e

echo "=========================================="
echo "員工薪資管理系統 - 自動部署腳本"
echo "=========================================="

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 記錄函數
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 檢查系統要求
check_requirements() {
    log_info "檢查系統要求..."

    # 檢查 Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js 未安裝。請安裝 Node.js 18+ 版本"
        exit 1
    fi

    NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        log_error "Node.js 版本過舊。需要 18+ 版本，當前版本: $(node --version)"
        exit 1
    fi

    log_info "Node.js 版本: $(node --version) ✓"

    # 檢查 npm
    if ! command -v npm &> /dev/null; then
        log_error "npm 未安裝"
        exit 1
    fi

    log_info "npm 版本: $(npm --version) ✓"

    # 檢查 PostgreSQL (可選)
    if command -v psql &> /dev/null; then
        log_info "PostgreSQL 可用: $(psql --version | head -n1) ✓"
    else
        log_warn "本地 PostgreSQL 未安裝。將使用 Supabase 雲端資料庫"
    fi
}

# 安裝依賴
install_dependencies() {
    log_info "安裝項目依賴..."

    if [ -f "package-lock.json" ]; then
        npm ci
    else
        npm install
    fi

    log_info "依賴安裝完成 ✓"
}

# 設置環境變數
setup_environment() {
    log_info "設置環境變數..."

    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
            log_info "已創建 .env 文件，請編輯後重新執行部署"
            log_warn "請在 .env 文件中設置以下變數:"
            echo "  - DATABASE_URL (PostgreSQL 連接字串)"
            echo "  - SESSION_SECRET (會話密鑰)"
            echo "  - ADMIN_PIN (管理員 PIN 碼)"
            echo ""
            echo "範例:"
            echo "DATABASE_URL=postgresql://<db-user>:<db-password>@db.example.test:5432/<db-name>"
            echo "SESSION_SECRET=your-random-secret-key-here"
            echo "ADMIN_PIN=1234"
            echo ""
            exit 1
        else
            log_error ".env.example 文件不存在"
            exit 1
        fi
    fi

    # 檢查必要的環境變數
    source .env

    if [ -z "$DATABASE_URL" ]; then
        log_error "DATABASE_URL 未設置"
        exit 1
    fi

    if [ -z "$SESSION_SECRET" ]; then
        log_error "SESSION_SECRET 未設置"
        exit 1
    fi

    log_info "環境變數檢查完成 ✓"
}

# 資料庫設置
setup_database() {
    log_info "設置資料庫..."

    # 檢查資料庫連接
    if npm run db:check > /dev/null 2>&1; then
        log_info "資料庫連接正常 ✓"
    else
        log_warn "資料庫連接失敗，嘗試初始化..."

        # 推送資料庫結構
        npm run db:push

        if [ $? -eq 0 ]; then
            log_info "資料庫初始化完成 ✓"
        else
            log_error "資料庫初始化失敗"
            exit 1
        fi
    fi
}

# 建置應用
build_application() {
    log_info "建置應用程式..."

    npm run build

    if [ $? -eq 0 ]; then
        log_info "應用建置完成 ✓"
    else
        log_error "應用建置失敗"
        exit 1
    fi
}

# 創建系統服務 (適用於 Linux)
create_systemd_service() {
    if [ "$EUID" -ne 0 ]; then
        log_warn "非 root 用戶，跳過系統服務創建"
        return
    fi

    log_info "創建 systemd 服務..."

    APP_DIR=$(pwd)
    SERVICE_FILE="/etc/systemd/system/salary-system.service"

    cat > $SERVICE_FILE << EOF
[Unit]
Description=Employee Salary Management System
After=network.target

[Service]
Type=simple
User=node
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable salary-system

    log_info "systemd 服務創建完成 ✓"
}

# 設置 PM2 (推薦的生產環境管理器)
setup_pm2() {
    log_info "設置 PM2 進程管理器..."

    if ! command -v pm2 &> /dev/null; then
        log_info "安裝 PM2..."
        npm install -g pm2
    fi

    # 創建 PM2 配置文件
    cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'salary-system',
    script: 'server/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    }
  }]
};
EOF

    log_info "PM2 配置完成 ✓"
}

# 設置 Nginx 反向代理 (可選)
setup_nginx() {
    if [ "$1" != "--with-nginx" ]; then
        return
    fi

    if [ "$EUID" -ne 0 ]; then
        log_warn "非 root 用戶，跳過 Nginx 設置"
        return
    fi

    log_info "設置 Nginx 反向代理..."

    if ! command -v nginx &> /dev/null; then
        log_error "Nginx 未安裝"
        return
    fi

    NGINX_CONF="/etc/nginx/sites-available/salary-system"

    cat > $NGINX_CONF << EOF
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

    ln -sf $NGINX_CONF /etc/nginx/sites-enabled/
    nginx -t && systemctl reload nginx

    log_info "Nginx 設置完成 ✓"
}

# 運行測試
run_tests() {
    log_info "運行應用測試..."

    if [ -f "package.json" ] && grep -q "\"test\"" package.json; then
        npm test

        if [ $? -eq 0 ]; then
            log_info "測試通過 ✓"
        else
            log_warn "部分測試失敗，但繼續部署"
        fi
    else
        log_warn "未找到測試腳本，跳過測試"
    fi
}

# 啟動應用
start_application() {
    log_info "啟動應用程式..."

    if command -v pm2 &> /dev/null && [ -f "ecosystem.config.js" ]; then
        # 使用 PM2 啟動
        pm2 start ecosystem.config.js
        pm2 save
        pm2 startup
        log_info "應用已通過 PM2 啟動 ✓"
    elif [ -f "/etc/systemd/system/salary-system.service" ]; then
        # 使用 systemd 啟動
        systemctl start salary-system
        systemctl status salary-system
        log_info "應用已通過 systemd 啟動 ✓"
    else
        # 直接啟動
        log_info "直接啟動應用 (開發模式)..."
        npm start &
        sleep 5

        # 檢查應用是否正常運行
        if curl -s http://localhost:5000 > /dev/null; then
            log_info "應用啟動成功 ✓"
        else
            log_error "應用啟動失敗"
            exit 1
        fi
    fi
}

# 部署後檢查
post_deploy_check() {
    log_info "執行部署後檢查..."

    # 等待應用啟動
    sleep 10

    # 檢查應用健康狀態
    if curl -s http://localhost:5000/api/health > /dev/null 2>&1; then
        log_info "應用健康檢查通過 ✓"
    else
        log_warn "健康檢查失敗，但應用可能仍在啟動中"
    fi

    # 檢查資料庫連接
    if npm run db:check > /dev/null 2>&1; then
        log_info "資料庫連接檢查通過 ✓"
    else
        log_warn "資料庫連接檢查失敗"
    fi

    log_info "部署檢查完成"
}

# 創建備份目錄
setup_backup_directories() {
    log_info "創建備份目錄..."

    mkdir -p backups/{daily,weekly,monthly}
    mkdir -p logs

    log_info "備份目錄創建完成 ✓"
}

# 主要部署流程
main() {
    echo ""
    log_info "開始部署員工薪資管理系統..."
    echo ""

    # 解析命令行參數
    WITH_NGINX=false
    SKIP_TESTS=false

    for arg in "$@"; do
        case $arg in
            --with-nginx)
                WITH_NGINX=true
                ;;
            --skip-tests)
                SKIP_TESTS=true
                ;;
            --help)
                echo "用法: $0 [選項]"
                echo ""
                echo "選項:"
                echo "  --with-nginx     配置 Nginx 反向代理"
                echo "  --skip-tests     跳過測試階段"
                echo "  --help          顯示此幫助信息"
                echo ""
                exit 0
                ;;
        esac
    done

    # 執行部署步驟
    check_requirements
    install_dependencies
    setup_environment
    setup_database

    if [ "$SKIP_TESTS" = false ]; then
        run_tests
    fi

    build_application
    setup_backup_directories
    setup_pm2

    if [ "$WITH_NGINX" = true ]; then
        setup_nginx --with-nginx
    fi

    create_systemd_service
    start_application
    post_deploy_check

    echo ""
    echo "=========================================="
    log_info "部署完成!"
    echo "=========================================="
    echo ""
    echo "應用訪問地址: http://localhost:5000"
    echo "管理員登入: admin / 1234 (預設)"
    echo ""
    echo "重要命令:"
    echo "  - 查看應用狀態: pm2 status"
    echo "  - 查看日誌: pm2 logs salary-system"
    echo "  - 重啟應用: pm2 restart salary-system"
    echo "  - 停止應用: pm2 stop salary-system"
    echo ""
    echo "配置文件位置:"
    echo "  - 環境變數: .env"
    echo "  - PM2 配置: ecosystem.config.js"
    echo "  - 備份目錄: ./backups/"
    echo ""
    log_info "部署成功完成!"
}

# 錯誤處理
trap 'log_error "部署過程中發生錯誤，請檢查上述輸出"' ERR

# 執行主函數
main "$@"
