# 更改记录

> 每次提交前更新本文件，**最新记录在最上面**。
> 格式：日期（精确到日）+ 修改功能简述。

## 2026-09-19

- 初始化项目：建立 Electron + React + TypeScript 工程骨架
- 锁定依赖版本：electron 44 / vite 7 / electron-vite 5 / electron-builder 26
  （注意：vite 8 与 electron-vite 5 不兼容，必须锁 ^7；@vitejs/plugin-react 需用 5.x）
- 配置 Electron 二进制下载镜像，规避本机代理对 GitHub CDN 的 502 问题
