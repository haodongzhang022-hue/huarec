#!/usr/bin/env bash
# HuaRec 花录 — 每次 master push 自动发版脚本
#
# 效果（对齐 huashu-design 仓库体验：非常自动、非常醒目）：
#   - 自动递增 manifest.json 中的 patch 版本号（版本历史可追溯）
#   - 打包插件 zip（仅含插件运行所需文件）
#   - 发布/更新稳定 tag（latest）的 Release，zip 作为附件覆盖上传
#   - Release 描述中维护版本历史表格，最新版本置顶，附永久下载直链
#   - 版本号 bump 提交回 master（[skip ci] 不触发新流水线）
#
# 依赖环境变量：CNB_TOKEN / CNB_REPO_SLUG / CNB_COMMIT / CNB_COMMIT_SHORT /
#               CNB_BUILD_ID / CNB_WEB_HOST（流水线自动注入）
# 依赖工具：bash / git / zip / curl / jq / cnb（由 .cnb.yml 的 Dockerfile 预装）
set -euo pipefail

TAG="latest"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

echo "==> 1/6 递增版本号（manifest.json 为唯一版本源）"
OLD_VERSION=$(grep -o '"version"[^,]*' manifest.json | cut -d'"' -f4)
MAJOR=$(echo "${OLD_VERSION}" | cut -d. -f1)
MINOR=$(echo "${OLD_VERSION}" | cut -d. -f2)
PATCH=$(echo "${OLD_VERSION}" | cut -d. -f3)
PATCH=$((PATCH + 1))
NEXT_VERSION="${MAJOR}.${MINOR}.${PATCH}"
NEXT_TAG="v${NEXT_VERSION}"
sed -i "s/\"version\": \"${OLD_VERSION}\"/\"version\": \"${NEXT_VERSION}\"/" manifest.json
grep '"version"' manifest.json
ZIP_NAME="huarec-${NEXT_VERSION}.zip"
echo "    version: ${OLD_VERSION} -> ${NEXT_VERSION}"

echo "==> 2/6 打包插件 zip（仅运行所需文件）"
STAGE_DIR="${WORK_DIR}/huarec-${NEXT_VERSION}"
mkdir -p "${STAGE_DIR}"
cp manifest.json background.js offscreen.html offscreen.js permission.html permission.js "${STAGE_DIR}"/
cp -r content editor icons lib popup assets "${STAGE_DIR}"/
rm -f "${STAGE_DIR}/icons/make_icons.py"
rm -rf "${STAGE_DIR}/assets/wallpapers/_raw"
(cd "${STAGE_DIR}" && zip -q -r "${WORK_DIR}/${ZIP_NAME}" .)
ZIP_PATH="${WORK_DIR}/${ZIP_NAME}"
ZIP_SIZE=$(stat -c%s "${ZIP_PATH}")
echo "    ${ZIP_NAME}: $(du -h "${ZIP_PATH}" | cut -f1)"

echo "==> 3/6 生成 Release 描述（版本历史表格 + 安装指引）"
BODY_FILE="${WORK_DIR}/body.md"
COMMIT_LOG=$(git log -10 --pretty=format:"- %s" | grep -v "自动发版" || git log -1 --pretty=format:"- %s")
DOWNLOAD_BASE="https://${CNB_WEB_HOST}/${CNB_REPO_SLUG}/-/releases/download/${TAG}"
cat > "${BODY_FILE}" <<EOF
## HuaRec 花录 — 最新版本 ${NEXT_TAG}

| 文件 | 说明 |
|------|------|
| [⬇️ ${ZIP_NAME}](${DOWNLOAD_BASE}/${ZIP_NAME}) | Chrome 扩展安装包（当前最新版本） |

> 💡 每次 master 更新都会自动递增版本号、重新打包并覆盖本 Release 附件，本页永远是最新版。

### 安装方式
1. 下载并解压 zip 到本地目录（解压后目录内应直接包含 \`manifest.json\`）
2. 打开 Chrome，访问 \`chrome://extensions/\`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择解压后的目录

### 本次更新（${NEXT_TAG}）
${COMMIT_LOG}

---
- Commit: \`${CNB_COMMIT_SHORT}\`
- 构建: [#${CNB_BUILD_ID}](https://${CNB_WEB_HOST}/${CNB_REPO_SLUG}/-/build/${CNB_BUILD_ID})

> 本 Release 由流水线自动生成（scripts/release-latest.sh），请勿手动编辑。
EOF

echo "==> 4/6 准备 Release（稳定 tag: ${TAG}）"
RELEASE_JSON=$(cnb releases get-release-by-tag --repo "${CNB_REPO_SLUG}" --tag "${TAG}" --verbose 2>/dev/null || true)
RELEASE_ID=$(echo "${RELEASE_JSON}" | jq -r 'try (.data.id // .data.release.id // empty)' 2>/dev/null || true)

if [ -z "${RELEASE_ID}" ]; then
  echo "    Release 不存在，创建新的"
  CREATE_JSON=$(cnb releases post-release --repo "${CNB_REPO_SLUG}" \
    --tag-name "${TAG}" --target-commitish "${CNB_COMMIT}" \
    --name "HuaRec 花录 · 最新版（自动更新）" \
    --body-file "${BODY_FILE}" --verbose)
  RELEASE_ID=$(echo "${CREATE_JSON}" | jq -r '.data.id // .data.release.id')
else
  echo "    Release 已存在（id=${RELEASE_ID}），更新标题/描述"
  cnb releases patch-release --repo "${CNB_REPO_SLUG}" --release-id "${RELEASE_ID}" \
    --name "HuaRec 花录 · 最新版（自动更新）" \
    --body-file "${BODY_FILE}" >/dev/null
fi
echo "    RELEASE_ID=${RELEASE_ID}"

echo "==> 5/6 上传 zip 附件（同名覆盖，永保最新）"
UP_JSON=$(cnb releases post-release-asset-upload-url --repo "${CNB_REPO_SLUG}" \
  --release-id "${RELEASE_ID}" --asset-name "${ZIP_NAME}" --size "${ZIP_SIZE}" --overwrite --verbose)
echo "${UP_JSON}" | jq -e '.data' >/dev/null

UPLOAD_URL=$(echo "${UP_JSON}" | jq -r '.data.upload_url // .data.url // empty')
if [ -z "${UPLOAD_URL}" ]; then
  echo "!! 无法解析 upload_url，原始响应：" >&2
  echo "${UP_JSON}" | jq '.' >&2
  exit 1
fi

HTTP_CODE=$(curl -sS -o "${WORK_DIR}/put_resp.json" -w "%{http_code}" -X PUT \
  -H "Content-Type: application/zip" --data-binary "@${ZIP_PATH}" "${UPLOAD_URL}")
echo "    PUT ${HTTP_CODE}"
[ "${HTTP_CODE}" -ge 200 ] && [ "${HTTP_CODE}" -lt 300 ] || { cat "${WORK_DIR}/put_resp.json" >&2; exit 1; }

# 解析确认参数：verify_url 格式为
#   https://api.<host>/<slug>/-/releases/<id>/asset-upload-confirmation/<upload_token>/<url编码的asset_path>?ttl=0
# upload_token 与 asset_path 在 URL 路径段中（非查询参数），需按路径段提取并做 URL 解码。
VERIFY_URL=$(echo "${UP_JSON}" | jq -r '.data.verify_url // empty')
UPLOAD_TOKEN=""
ASSET_PATH=""
if [ -n "${VERIFY_URL}" ]; then
  URL_PATH="${VERIFY_URL%%\?*}"   # 去掉 ?ttl=0 查询串
  UPLOAD_TOKEN=$(echo "${URL_PATH}" | sed -n 's|.*/asset-upload-confirmation/\([^/]*\)/.*|\1|p')
  RAW_ASSET_PATH=$(echo "${URL_PATH}" | sed -n 's|.*/asset-upload-confirmation/[^/]*/\(.*\)|\1|p')
  # URL 解码（%2F -> / 等），纯 bash 实现避免依赖 python
  ASSET_PATH=$(printf '%b' "${RAW_ASSET_PATH//%/\\x}")
fi
UPLOAD_TOKEN=${UPLOAD_TOKEN:-$(echo "${UP_JSON}" | jq -r '.data.upload_token // empty')}
ASSET_PATH=${ASSET_PATH:-$(echo "${UP_JSON}" | jq -r '.data.asset_path // empty')}

if [ -z "${UPLOAD_TOKEN}" ] || [ -z "${ASSET_PATH}" ]; then
  # 缺少确认参数会导致附件不会挂载到 Release（下载 404），必须视为失败而非跳过
  echo "!! 无法从 verify_url 解析 upload_token/asset_path，附件将无法挂载到 Release" >&2
  echo "   verify_url: ${VERIFY_URL}" >&2
  exit 1
fi
cnb releases post-release-asset-upload-confirmation --repo "${CNB_REPO_SLUG}" \
  --release-id "${RELEASE_ID}" --upload-token "${UPLOAD_TOKEN}" --asset-path "${ASSET_PATH}" --ttl 0 >/dev/null
echo "    附件上传已确认: ${ASSET_PATH}"

echo "==> 6/6 提交版本号 bump 回 master（[skip ci] 防循环触发）"
git config user.name "cnb-bot"
git config user.email "bot@cnb.cool"
git add manifest.json
if git diff --cached --quiet; then
  echo "    manifest.json 无变化，跳过提交"
else
  git commit -m "chore(release): 自动发版 ${NEXT_TAG} — 版本号递增 [skip ci]"
  git push "https://oauth2:${CNB_TOKEN}@${CNB_WEB_HOST}/${CNB_REPO_SLUG}.git" HEAD:master
  echo "    版本号已提交回 master: ${NEXT_VERSION}"
fi

echo ""
echo "=============================================="
echo "🎉 自动发版完成: ${NEXT_TAG}"
echo "   Releases 页: https://${CNB_WEB_HOST}/${CNB_REPO_SLUG}/-/releases"
echo "   zip 直链:    ${DOWNLOAD_BASE}/${ZIP_NAME}"
echo "=============================================="
