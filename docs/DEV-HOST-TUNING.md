# 开发宿主机调优（需要 root 的项目）

<!-- 🍞 AI Breadcrumb — @COUPLED docs/PERF-SESSION-LOAD.md §7.3, docs/OPERATIONS.md -->

本文只列**开发/在线宿主机上需要 root 才能做**的两项调优，以及它们的适用条件与回退方式。开发用户 `dev` 无 sudo（容器 `no new privileges`），因此这些命令必须由操作者执行；执行前后请各自确认服务状态。

宿主机参考配置：4 vCPU / 7.9 GB / 40 GB / **无 swap**（`C202609091757997`）。

---

## 1. nginx 开启 HTTP/2

现状：`/etc/nginx/sites-enabled/pi-dev-dev.ftai.cc` 是 `listen 443 ssl;`（无 `http2`），前端 bundle 走 HTTP/1.1 的 6 连接并发；JS/CSS 由应用侧 `compression()` 压缩（nginx 的 `gzip_types` 在 `nginx.conf` 里被注释，只压 `text/html`，不影响本项）。

```bash
# 1) 备份并改成 http2（nginx ≥ 1.25.1 用 http2 on；更老版本用 listen ... http2）
sudo cp /etc/nginx/sites-enabled/pi-dev-dev.ftai.cc /root/pi-dev-nginx-$(date +%F).bak
sudo sed -i 's/^\(\s*\)listen 443 ssl;/\1listen 443 ssl;\n\1http2 on;/' /etc/nginx/sites-enabled/pi-dev-dev.ftai.cc
# 老版本 nginx 改用：listen 443 ssl http2;

# 2) 语法检查后热加载（不中断连接）
sudo nginx -t && sudo systemctl reload nginx

# 3) 验证：应为 HTTP/2
curl -skI --http2 https://127.0.0.1/ -H 'Host: dev.ftai.cc' | head -1
```

回退：还原备份文件并 `sudo systemctl reload nginx`。注意 WebSocket 反代（`proxy_http_version 1.1` + `Upgrade`/`Connection`）在 HTTP/2 下由 nginx 自行降级到 1.1，无需改动。

---

## 2. 加 2–4 GB swap（防 OOM 保险，不是性能手段）

现状：`swapon --show` 为空。8 GB 内存上同时跑 Chromium（e2e/Playwright）、构建与 2 GB node heap 时没有余量；PM2 的 `max_memory_restart=3G` 一旦命中，表现是**重启而不是变慢**。

```bash
# 1) 建 swapfile（磁盘需 ≥4 GB 余量；当前 / 为 62%）
sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# 2) 开机自动挂载
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 3) 验证
swapon --show && free -m
```

建议同时把 `vm.swappiness` 调低（默认 60，对「防 OOM」场景偏激进）：

```bash
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-pi-dev-swap.conf
sudo sysctl --system
```

回退：`sudo swapoff /swapfile && sudo rm /swapfile`，并删除 `/etc/fstab` 与 `/etc/sysctl.d/` 里的对应行。

---

## 3. 已经做过、不需要 root 的项（记录在此以免重复）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 清理历史 release（`deploy/releases` 曾 7.0 GB / 4 个版本） | `node scripts/release.mjs prune --apply` | 移除 `f1c607278519`、`004d9f3444ec`；保留当前 `e60b9541ed30` 与回滚目标 `99f9651fb193`；磁盘 69% → 62% |
| 重活让出 CPU | 无需操作 | `test:smoke` / `test:performance` / `test:channels:browser` 已加 `nice -n 10`（见根 `package.json`） |
| 压缩阈值 / 扩展 / 列表扫描 | — | 见 [PERF-SESSION-LOAD.md](PERF-SESSION-LOAD.md) §7 |

**不适用**：PM2 cluster（会话/PTY/WS 状态未设计为多进程共享，见 [STRUCTURE.md](STRUCTURE.md)）；结论与路线见 [EVENT-LOOP-SPLIT-PROPOSAL.md](EVENT-LOOP-SPLIT-PROPOSAL.md)。
