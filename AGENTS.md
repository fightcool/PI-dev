# PI-dev Agent Instructions

本文件是本项目在开发服务器上的操作约定，供 AI 助手和开发者参考。不要在此文件或仓库中写入任何密码、令牌、私钥、会话、访问口令或其他真实凭据。

## 环境与身份

- 项目目录：`/home/dev/PI-dev`；开发与测试可使用同仓库的独立 worktree
- 修改目录、构建或部署前阅读 [docs/STRUCTURE.md](docs/STRUCTURE.md)；在线服务与开发 checkout 分离，根命令是 PI-dev 工程入口。
- 当前开发用户：`dev`
- 开发服务器：`C202609091757997`
- GitHub 账号：`fightcool`
- GitHub 仓库：`fightcool/PI-dev`
- 默认分支：`feat/isolated-dev-environment`
- 当前 UI 运行服务器：`C202609091757997`，用户 `dev`，入口 `dev.ftai.cc`
- 可选远端部署服务器别名：`leika-1`
- 远端部署地址：`ftai.cc`（`103.38.83.251`）
- 远端部署用户：`deploy`；实际部署目标以本次任务授权为准

项目文件、依赖、测试和 Git 操作应以 `dev` 用户执行。不要使用 `root` 运行项目、安装项目依赖或生成项目文件。

## 凭据边界

凭据由操作系统用户环境提供，不要读取、打印、复制或提交以下内容：

- `/home/dev/.ssh/id_ed25519_github`
- `/home/dev/.ssh/id_ed25519_leika1`
- `/home/dev/.config/gh/hosts.yml`
- 任何 GitHub Token、服务器密码、模型凭据、访问口令或会话文件

不要把凭据写入源码、日志、命令参数、环境变量、PR、Issue 或聊天内容。不要为了方便把私钥复制到项目目录、`/root` 或目标部署服务器。

## 开始工作前

```bash
cd /home/dev/PI-dev
git status --short --branch
git fetch origin
```

如果工作树存在不属于当前任务的修改，不要覆盖、重置或删除；先报告并确认。不要使用 `git reset --hard`、`git clean -fd` 或批量删除来“解决”状态问题。

## 分支、提交与推送

- 不直接在默认分支上开发。
- 每个功能、修复或部署变更使用独立分支。
- 分支名使用简洁的 `feature/…`、`fix/…` 或 `chore/…` 格式。
- 提交前检查变更范围，不提交运行数据、构建产物、`.venv`、`node_modules`、日志或凭据。

```bash
cd /home/dev/PI-dev
git switch -c feature/short-description
# 修改并测试
git diff --check
git status --short
git add <明确的文件>
git commit -m "描述实际变更"
git push -u origin HEAD
```

除非用户明确要求，不要改写已推送提交历史，不要强制推送。

## 测试与质量检查

根据变更范围运行必要检查。常用检查包括：

```bash
npm test
.venv/bin/python -m pytest tests/test_environment.py -q
npm run check:publish
npm run smoke
```

依赖安装和服务安装遵循 README 与现有锁文件；优先使用项目已有脚本，不要随意升级锁文件或全局工具链。

在报告结果时明确说明实际运行过的命令和失败信息，不要声称未运行的测试已通过。

## GitHub、PR 与合并

GitHub SSH 远端为：

```text
git@github.com:fightcool/PI-dev.git
```

GitHub CLI 已由 `dev` 用户配置。常用命令：

```bash
gh auth status
gh pr list --repo fightcool/PI-dev
gh pr view <PR_NUMBER> --repo fightcool/PI-dev
gh pr create --base feat/isolated-dev-environment --head <BRANCH> \
  --title "标题" --body "说明"
```

创建 PR 前必须确认：

1. 工作树状态和变更范围正确；
2. 分支已经推送；
3. 相关测试已经运行；
4. PR 说明包含变更内容和验证结果；
5. 没有把凭据或运行数据包含在提交中。

合并是改变远端仓库历史的操作。只有在用户明确要求合并，且 PR、CI、审查和目标分支均符合要求时才执行：

```bash
gh pr merge <PR_NUMBER> --repo fightcool/PI-dev --merge
```

除非用户明确要求，不要自动合并、关闭 PR、删除远端分支或修改仓库保护规则。

## 部署到莱卡1号

通过当前开发服务器的 `dev` 用户连接目标机：

```bash
ssh leika-1
```

该连接使用 `deploy` 用户，不是 root。部署前必须先完成本地测试、确认分支/提交，并检查目标目录和服务状态。优先使用仓库已有部署脚本与 systemd 模板，不要临时拼接未经审查的破坏性命令。

可以进行只读检查：

```bash
ssh leika-1 'whoami && hostname && hostname -I && pwd'
ssh leika-1 'systemctl --user --no-pager list-units 2>/dev/null || true'
```

以下操作需要用户明确确认后才能执行：

- 删除或覆盖目标机上的项目、数据、配置或日志；
- 重启、停止或禁用生产服务；
- 修改 SSH、sudo、防火墙或系统升级配置；
- 执行数据库迁移、回滚或批量清理；
- 任何需要 root 权限的操作。

不要配置或使用不可撤销的永久 root SSH 入口。不要把目标服务器密码或 root 私钥放到开发服务器。

## 变更与安全原则

- 先检查目标，再编辑、覆盖、删除或重启。
- 不把网络上下载的脚本直接通过 `curl | sh` 执行。
- 不绕过测试、分支保护、审核或权限控制。
- 不因命令失败而盲目重试可能产生副作用的操作。
- 对外发布、推送、创建 PR、合并 PR、部署和删除操作，在执行前确认范围；已经明确授权的常规可逆操作可直接执行。
- 所有输出和日志都必须避免泄露凭据。
