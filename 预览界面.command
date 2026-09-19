#!/bin/bash
# 库存管理系统 — 浏览器预览启动器
#
# 不启动 Electron，直接在浏览器里看界面，改完代码重跑一次就能看到效果。
# 注意：数据是内存模拟的，刷新即重置，不会写到磁盘。

NODE_DIR="/Users/hui/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin"
export PATH="$NODE_DIR:$PATH"

cd "/Users/hui/WorkBuddy AI/仓库管理系统" || exit 1

echo "Node: $(node -v)"
echo ""
echo "正在构建渲染进程…"

if ! npm run build >/tmp/wh-preview-build.log 2>&1; then
  echo "构建失败，日志末尾："
  tail -20 /tmp/wh-preview-build.log
  echo ""
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

echo "构建完成，启动预览服务…"
node preview/build-preview.mjs
