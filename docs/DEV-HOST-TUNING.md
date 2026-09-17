# 开发宿主机调优（需要 root 的项目）

<!-- 🍞 AI Breadcrumb — @COUPLED docs/PERF-SESSION-LOAD.md §7.3, docs/OPERATIONS.md -->

本文只列**开发/在线宿主机上需要 root 才能做**的两项调优，以及它们的适用条件、逐步验证与回退方式。开发用户 `dev` 无 sudo（容器 `no new privileges`），这些命令必须由操作者执行。

宿主机参考配置：4 vCPU / 7.9 GB / 40 GB / **无 swap**（`C202609091757997`）。

> ⚠️ **先读第 3 节**：这两项在本机都踩过坑（nginx 1.18 不支持 `http2 on;`、`sed -i` 会把 symlink 换成普通文件、多行粘贴只执行了一部分导致 `/swapfile` 建出来但没启用）。照第 3 节的「逐步执行 + 每步验证」走。

---

## 1. nginx 开启 HTTP/2

现状：`/etc/nginx/sites-enabled/pi-dev-dev.ftai.cc` → `sites-available/pi-dev-dev.ftai.cc` 是 `listen 443 ssl;`（无 `http2`），前端 bundle 走 HTTP/1.1 的 6 连接并发。JS/CSS 已由应用侧 `compression()` 压缩（nginx 的 `gzip_types` 在 `nginx.conf` 里被注释，只压 `text/html`，不影响本项）。

**先看版本**（指令形态由它决定）：

```bash
/usr/sbin/nginx -v      # 本机：nginx/1.18.0 (Ubuntu)
```

| nginx 版本 | 写法 |
| --- | --- |
| ≥ 1.25.1 | 在 server 块里加一行 `http2 on;`（`listen` 参数形式已弃用） |
| 1.9.5 – 1.25.0（**本机属于这档**） | 把 `listen 443 ssl;` 改成 `listen 443 ssl http2;`，IPv6 那行同样要加 |

**改配置文件本体，不要 `sed -i` 打 symlink**（`sites-enabled/*` 是符号链接，GNU `sed -i` 会用普通文件替换它，或用 `sed --follow-symlinks`）：

```bash
F=/etc/nginx/sites-available/pi-dev-dev.ftai.cc

# 1) 备份（文件名带日期）
sudo cp "$F" "/root/pi-dev-nginx-$(date +%F).bak"

# 2) 只在 443 的两条 listen 上加 http2（1.18 档；两条都要，否则 IPv6 仍走 1.1）
sudo sed -i --follow-symlinks \
  -e 's/^\(\s*\)listen 443 ssl;/\1listen 443 ssl http2;/' \
  -e 's/^\(\s*\)listen \[::\]:443 ssl ipv6only=on;/\1listen [::]:443 ssl ipv6only=on http2;/' "$F"

# 3) 必须在 reload **之前**确认语法通过（任何报错都不要继续）
sudo /usr/sbin/nginx -t

# 4) 通过后热加载（不中断连接）
sudo systemctl reload nginx

# 5) 验证：必须是 HTTP/2
curl -skI --http2 https://127.0.0.1/ -H 'Host: dev.ftai.cc' | head -1   # 期望 HTTP/2 200
curl -s -o /dev/null -w '%{http_version}\n' https://dev.ftai.cc/         # 期望 2
```

回退：`sudo cp /root/pi-dev-nginx-<日期>.bak /etc/nginx/sites-available/pi-dev-dev.ftai.cc && sudo nginx -t && sudo systemctl reload nginx`。

WebSocket 反代（`proxy_http_version 1.1` + `Upgrade`/`Connection`）在 HTTP/2 下由 nginx 自行降级到 1.1，无需改动。

---

## 2. 加 4 GB swap（防 OOM 保险，不是性能手段）

现状：`swapon --show` 为空。8 GB 内存上同时跑 Chromium（e2e/Playwright）、构建与 2 GB node heap 时没有余量；PM2 的 `max_memory_restart=3G` 一旦命中，表现是**重启而不是变慢**。

**逐步执行，每一步都要有预期输出**（别整段粘贴）：

```bash
# 1) 建 4 GB 文件（磁盘需 ≥4 GB 余量）——完成后：ls -l /swapfile 应显示 4294967296
sudo fallocate -l 4G /swapfile

# 2) 权限必须是 600（0644 的 swap 文件任何人可读，属安全问题）
sudo chmod 600 /swapfile && ls -l /swapfile        # 期望 -rw-------

# 3) 格式化——完成后会打印 "Setting up swapspace version 1, size = 4 GiB"
sudo mkswap /swapfile

# 4) 启用——完成后 swapon --show 必须列出 /swapfile，free -m 的 Swap 不再是 0
sudo swapon /swapfile
swapon --show && free -m

# 5) 开机自动挂载（幂等：先确认没写过）
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

建议把 `vm.swappiness` 调低（默认 60 对「防 OOM」场景偏激进）：

```bash
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-pi-dev-swap.conf
sudo sysctl --system      # 完成后 cat /proc/sys/vm/swappiness 应为 10
```

回退 / 撤销：`sudo swapoff /swapfile && sudo rm /swapfile`，并删除 `/etc/fstab` 与 `/etc/sysctl.d/90-pi-dev-swap.conf` 里的对应行。

> 注意：**只建了 `/swapfile` 而没执行 `mkswap`/`swapon` 不算加了 swap**（`swapon --show` 为空、`free` 里 Swap 为 0）；此时那 4 GB 只是占着磁盘。要么补齐第 2–5 步，要么按上面回退清掉。

---

## 3. 本机实测踩过的坑（照做可避免）

| 现象 | 原因 | 做法 |
| --- | --- | --- |
| `nginx: [emerg] unknown directive "http2"` | nginx **1.18** 不认识 `http2 on;`（需 ≥1.25.1） | 用 `listen 443 ssl http2;` 形态（见 §1 表格）；`http2 on;` 只给 ≥1.25.1 |
| `sites-enabled/*` 从 symlink 变成普通文件 | `sed -i` 直接作用在 symlink 上会用新文件替换链接 | 改 `sites-available/` 本体，或 `sed --follow-symlinks` |
| `/swapfile` 存在但 `swapon --show` 为空 | 多行粘贴只执行了第一行（`fallocate` 成功、后面没跑） | 逐行执行 + 每步验证（§2 的注释即验收点） |
| `nginx -t` 以普通用户跑报 `Permission denied`（证书/日志） | `dev` 无 sudo，读不到 `/etc/letsencrypt` 与 `/var/log/nginx` | 只用 root 跑 `nginx -t`；非 root 验证走 `curl` 与版本号 |
| reload 没生效但站点仍可用 | `nginx -t && systemctl reload` 里 `-t` 失败会短路，旧配置继续服务 | 这正是 `-t` 的价值：失败时**没有**切换，改好后重跑即可 |

---

## 4. 已经做过、不需要 root 的项（记录在此以免重复）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 清理历史 release（`deploy/releases` 曾 7.0 GB / 4 个版本） | `node scripts/release.mjs prune --apply` | 移除 `f1c607278519`、`004d9f3444ec`；保留当前 `e60b9541ed30` 与回滚目标 `99f9651fb193`；磁盘 69% → 62% |
| 重活让出 CPU | 无需操作 | `test:smoke` / `test:performance` / `test:channels:browser` 已加 `nice -n 10`（见根 `package.json`） |
| 压缩阈值 / 扩展 / 列表扫描 | — | 见 [PERF-SESSION-LOAD.md](PERF-SESSION-LOAD.md) §7 |

**不适用**：PM2 cluster（会话/PTY/WS 状态未设计为多进程共享，见 [STRUCTURE.md](STRUCTURE.md)）；结论与路线见 [EVENT-LOOP-SPLIT-PROPOSAL.md](EVENT-LOOP-SPLIT-PROPOSAL.md)。

## 5. 事件循环阻塞探针（无需 root）

```bash
PI_WEB_LOOP_PROBE=1 npm run dev          # 每 10s 一行 [loop]；超阈值打 `!`
# 可选：PI_WEB_LOOP_PROBE_MS=5000 / PI_WEB_LOOP_PROBE_THRESHOLD_MS=50
```

默认完全关闭（不建直方图、不起定时器）。输出形如
`[loop]! max=520.3ms p99=120.4ms mean=12.3ms over=3/96（阈值 100ms）`——
这是 [EVENT-LOOP-SPLIT-PROPOSAL.md](EVENT-LOOP-SPLIT-PROPOSAL.md) §4 验收指标 1 的测量手段。
