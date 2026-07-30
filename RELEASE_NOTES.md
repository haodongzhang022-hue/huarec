## HuaRec 花录 v1.2.2

Chrome 浏览器扩展安装包 `huarec-1.2.2.zip` 已挂载在本 Release 的附件中，可直接下载。

### 本次更新
- 合并来自 feat/auto-release-on-push 的合并请求 #21
- chore: bump version to 1.2.1 — 修正 README 版本号，验证自动打包流程
- 合并来自 feat/pack-zip-to-assets 的合并请求 #20
- feat(ci): 每次更新自动打包 zip 到制品附件，用户可直接下载
- feat: P0 跨标签页录制切换 — 自动接力 + 失败通知 + 审查修复终版 (#11)
- 合并来自 auto/fix-upload-404-1ead 的合并请求 #17
- fix(ci): 修复 Commit 附件上传脚本 — sha 放回 URL 路径、sed 解析 JSON、校验非空
- fix(ci): 用 curl + CNB REST API 替代缺失的 cnb CLI 上传 Commit 附件
- 合并来自 auto/fix-cnb-cli-38ce 的合并请求 #10

### 安装方式
1. 下载并解压 zip 到本地目录（解压后目录内应直接包含 `manifest.json`）
2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择解压后的目录
