#!/bin/bash
# 库存管理系统 — 开发环境启动器
# 使用 WorkBuddy 内置的 Node 运行，无需全局安装

NODE_DIR="/Users/hui/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin"
export PATH="$NODE_DIR:$PATH"

echo "Node: $(node -v)"
echo "npm:  $(npm -v)"
echo ""

cd "/Users/hui/WorkBuddy AI/仓库管理系统"

# 清理之前崩溃可能留下的残留锁
APP_SUPPORT="$HOME/Library/Application Support/warehouse-manager"
if [ -d "$APP_SUPPORT" ]; then
  rm -f "$APP_SUPPORT/SingletonLock" "$APP_SUPPORT/SingletonCookie" 2>/dev/null
  echo "已清理残留锁文件"
fi

echo "启动开发服务器..."
npm run dev
