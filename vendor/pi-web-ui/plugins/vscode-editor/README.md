# 📝 vscode-editor —— pi-web-ui 编辑器 + SSH 插件（Remote-SSH）

在 pi-web-ui 界面里提供一个类 VSCode 的工作台视图：

- **多根文件树**：本地工作区 + 已保存的 SSH 主机（同一棵树、同一组标签页）
- **工作区跟随**：主应用切换项目（set_cwd）后，本地树根目录实时切到新项目——
  自动清理目录缓存/展开状态、关闭本地标签（有未保存修改会提示），远端 SSH
  标签与连接不受影响；`.vscode/sftp.json` 每项目独立，切换后自动重读
- **CodeMirror 6 多标签编辑器**：本地/远程文件同开，语法高亮、Ctrl+S 保存
  （远程文件经 SFTP 写回）、CRLF 行尾保留、Ctrl+P 快速打开（本地）
- **底部可拖拽终端面板**：每台已连接主机可开多个 shell（xterm.js），窗口
  尺寸同步、keepalive 保活；右键远端文件/文件夹可在所在目录打开终端
- **SFTP 同步**（☁ 菜单）：工作区整体上传/下载、上传当前文件、保存自动上传
  （uploadOnSave）；配置存工作区 `.vscode/sftp.json`，与 **vscode-sftp / Natizyskunk.sftp**
  配置格式兼容——可直接把 VS Code 里的 `sftp.json` 拷过来用（Ctrl+S 即生效）。
  支持的字段：`name` / `host` / `port` / `username` / `password` / `passphrase` /
  `privateKey` / `privateKeyPath`（支持 `~` 展开，如 `~/.ssh/id_rsa`）/ `remotePath`（即
  远端根目录）/ `ignore`（glob 排除规则）/ `uploadOnSave` / 旧版 `watcher.autoUpload` /
  `agent`（如 `$SSH_AUTH_SOCK` 走 ssh-agent）。密码、私钥、agent 三者任选其一即可。
- **下载到电脑**（右键菜单）：本地文件直下；远端文件/文件夹不经工作区映射、
  文件夹在远端就地 tar.gz 打包，保存位置自选
- **上传文件**：工具栏 ⬆ 一键上传到工作区根目录；右键菜单「上传文件到此处…」
  （文件夹行 → 该文件夹、文件行 → 其所在目录、树内**空白处右键** → 该树根目录/
  首台已连 SSH 主机根；本地与远端 SFTP 均支持）；拖拽文件到文件树——文件夹行 →
  该文件夹、文件行 → 其所在目录、空白处 → 根目录（分片协议带覆盖确认与进度提示，
  树内拖拽会被插件拦截，不会触发主应用的「附加到对话」）

原独立的 ssh 插件已合并进来：旧 `<pluginDir>/ssh-hosts.json` 主机配置在首次
激活时自动迁移，无需手工搬。

## 文件树交互

- **原地展开/收起**：点文件夹只加载该目录子列表（带「⏳ 加载中」占位），
  不整树重绘闪烁；收起零延迟
- **选中高亮**：点/右键任意行都高亮选中，工具栏 ＋📄/＋📁 以当前选中目录
  为落点（选文件则落在其所在文件夹）；新建成功后新条目成为选中项
- **右键菜单**：新建 / 重命名 / 删除 / 上传文件到此处… / 双向同步 / 打开终端（scope 感知）

## 统一范围模型

scope = `"local" | connId`。前端所有文件操作（list/read/write/create/rename/
delete）携带 scope，远程时自动附加 connId——服务端据此路由到本地 fs 或该
连接的 SFTP，前后端共用一套代码路径。

## 目录结构

```
vscode-editor/
├── manifest.json        # 插件清单（id/icon/name）
├── index.mjs            # 服务端入口：本地文件 CRUD / SFTP 同步（.vscode/sftp.json）/
│                        #   SSH 主机管理 + 连接池 + PTY shell + exec + 远程 SFTP 操作
├── src/client.js        # 客户端源码（CodeMirror 6 + xterm.js）
├── build.mjs            # esbuild 打包脚本（xterm CSS 内联为文本）
├── package.json         # 构建/依赖清单（ssh2 为 devDep，运行时由服务端自动补装）
└── client/entry.mjs     # 构建产物（自包含 bundle，浏览器直接加载）
```

## 安装 / 卸载 / 更新

```bash
# ── 安装 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor
pi-web-ui install plugins/vscode-editor  # 或本地目录（开发态）
# 可选：--data-dir <dir> 自定义数据目录（默认 ~/.pi-web）

# ── 查看 ──
pi-web-ui plugins                            # 列出已装插件与 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor --force
                                             # --force 覆盖重装即更新
                                             # ⚠ 先备份插件目录里的 ssh-hosts.json 与
                                             #   工作区 .vscode/sftp.json（主机凭据/同步配置）

cp -r plugins/vscode-editor ~/.pi-web/plugins/  # 本地开发态：改完 src 后先 npm run build 再拷贝
                                             # Windows: %USERPROFILE%\.pi-web\plugins\vscode-editor
                                             # 只需 manifest.json + index.mjs + client/ 三部分，
                                             # node_modules / src / build.mjs 不需要拷贝

# ── 卸载 ──
pi-web-ui uninstall vscode-editor            # 移除插件目录（ssh-hosts.json 一并删除）
# 手动方式：rm -rf ~/.pi-web/plugins/vscode-editor
```

刷新页面后顶栏出现 📝 标签即成功。依赖 ssh2 不随包分发，首次激活自动 npm
补装到插件目录（失败可点侧栏「⚠ssh2」按钮手动触发）。
