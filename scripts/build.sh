#!/bin/bash
# dsh-patch-keeper 构建守卫（v0.2.0 起）
# 本插件 host（lib/index.js → 同步 lib/main.js）与 client 面板（lib/client.js）
# 均为手写纯 JS 维护，不经过 tsc / tsdown 构建——旧脚手架的 tsc 流程会用 src/
# 里的模板覆盖真实现，已移除。此脚本仅做同步与完整性校验。
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f lib/index.js ] || { echo "build: lib/index.js 缺失" >&2; exit 1; }
[ -f lib/client.js ] || { echo "build: lib/client.js 缺失（Web GUI 面板 bundle）" >&2; exit 1; }

# 同步入口副本（package.json main → ./lib/main.js）
cp -f lib/index.js lib/main.js

# 语法自检：host 按 ESM 实际导入验证；client 按脚本体解析验证
node -e "import('./lib/index.js').then(()=>console.log('host module OK')).catch(e=>{console.error(String(e));process.exit(1)})"
node -e "new Function(require('fs').readFileSync('lib/client.js','utf8')); console.log('client bundle OK')"

echo "build: OK（host=lib/main.js, client=lib/client.js —— 手写维护，勿用 tsc/tsdown 覆盖）"
