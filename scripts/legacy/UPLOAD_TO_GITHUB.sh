#!/bin/bash

# 🚀 GitHub 上傳腳本
# 執行前請先在 GitHub 建立新倉庫

echo "🎯 員工薪資管理系統 GitHub 上傳腳本"
echo "==========================================="

# 檢查是否有 Git
if ! command -v git &> /dev/null; then
    echo "❌ Git 未安裝，請先安裝 Git"
    exit 1
fi

# 獲取用戶輸入
read -p "請輸入您的 GitHub 用戶名: " GITHUB_USERNAME
read -p "請輸入倉庫名稱 (建議: employee-salary-system): " REPO_NAME

if [ -z "$GITHUB_USERNAME" ] || [ -z "$REPO_NAME" ]; then
    echo "❌ 用戶名和倉庫名不能為空"
    exit 1
fi

echo ""
echo "🔧 準備上傳到: https://github.com/$GITHUB_USERNAME/$REPO_NAME"
echo ""

# 初始化 Git 倉庫
echo "步驟 1: 初始化 Git 倉庫..."
git init

# 設定 Git 用戶 (如果未設定)
if [ -z "$(git config user.name)" ]; then
    read -p "請輸入您的 Git 用戶名: " GIT_NAME
    git config user.name "$GIT_NAME"
fi

if [ -z "$(git config user.email)" ]; then
    read -p "請輸入您的 Git 信箱: " GIT_EMAIL
    git config user.email "$GIT_EMAIL"
fi

# 添加所有檔案
echo "步驟 2: 添加專案檔案..."
git add .

# 檢查是否有檔案被添加
if [ -z "$(git status --porcelain)" ]; then
    echo "❌ 沒有檔案被添加，請檢查專案結構"
    exit 1
fi

# 顯示將要提交的檔案
echo "📁 將要上傳的檔案:"
git status --short

# 確認提交
echo ""
read -p "確認要提交這些檔案嗎? (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then
    echo "❌ 取消上傳"
    exit 1
fi

# 提交變更
echo "步驟 3: 提交變更..."
git commit -m "Initial commit: Employee Salary Management System

✨ 功能特色:
- 完整的薪資計算系統 (OT1/OT2 加班費)
- 考勤管理與條碼掃描器整合
- 月度薪資報表與 CSV 匯出
- 員工資料管理與加密存儲
- 自動備份與歷史記錄

🛠️ 技術棧:
- Frontend: React 18 + TypeScript + TailwindCSS
- Backend: Node.js + Express.js + Drizzle ORM
- Database: PostgreSQL (支援 Neon/Supabase)
- Features: 條碼掃描、自動備份、權限管理"

# 添加遠端倉庫
echo "步驟 4: 連接到 GitHub 倉庫..."
git remote add origin "https://github.com/$GITHUB_USERNAME/$REPO_NAME.git"

# 設定主分支
git branch -M main

# 推送到 GitHub
echo "步驟 5: 推送到 GitHub..."
echo "⚠️  如果是首次推送，可能需要輸入 GitHub 用戶名和密碼(或 token)"
git push -u origin main

# 檢查推送結果
if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 上傳成功！"
    echo "🔗 您的倉庫地址: https://github.com/$GITHUB_USERNAME/$REPO_NAME"
    echo "📚 README 和完整文件已包含在倉庫中"
    echo ""
    echo "🚀 下一步:"
    echo "1. 在 GitHub 查看您的倉庫"
    echo "2. 閱讀 README.md 了解部署選項"
    echo "3. 查看 GITHUB_UPLOAD_GUIDE.md 獲取詳細說明"
else
    echo ""
    echo "❌ 推送失敗，請檢查:"
    echo "1. 確認在 GitHub 已建立倉庫"
    echo "2. 檢查網路連線"
    echo "3. 確認 GitHub 用戶名和密碼正確"
    echo "4. 如果使用 2FA，請使用 personal access token"
fi