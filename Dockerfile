# HuaRec 花录 CI 构建环境：预装自动发版脚本所需全部工具
# （zip 打包 / git 推版本号 / curl+jq 上传附件 / cnb CLI 操作 Release）
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git curl jq zip \
    && rm -rf /var/lib/apt/lists/*

# CNB CLI：release-latest.sh 用它创建/更新 Release 及上传附件
RUN npm install -g @cnbcool/cnb-cli
