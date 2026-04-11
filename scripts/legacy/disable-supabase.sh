#!/bin/bash

# 設置 USE_SUPABASE 環境變量為 false
export USE_SUPABASE=false

# 檢查是否正在運行 npm run dev
if pgrep -f "npm run dev" > /dev/null; then
    echo "檢測到應用程序正在運行..."
    echo "重新啟動應用程序以使用 PostgreSQL 作為數據庫..."

    # 結束目前的進程
    pkill -f "npm run dev"

    # 等待進程結束
    sleep 2

    # 重新啟動應用程序
    npm run dev &

    echo "應用程序已重新啟動，現在使用 PostgreSQL 作為數據庫。"
else
    echo "應用程序未運行。"
    echo "當您啟動應用程序時，它將使用 PostgreSQL 作為數據庫。"
    echo "運行 'npm run dev' 以啟動應用程序。"
fi

echo ""
echo "要永久停用 Supabase，請在 Replit 環境變量中添加:"
echo "USE_SUPABASE=false"
echo ""