# PI-dev 文档导航

<!-- 🍞 AI Breadcrumb — @COUPLED DEV-CON-PROPOSAL.md, STRUCTURE.md, history/dev-con/README.md -->

**本仓库渠道管理功能的唯一开发范本是 [DEV-CON-PROPOSAL.md：PI-dev 多渠道开发基准](DEV-CON-PROPOSAL.md)。** 它统一产品边界、架构、配置所有权、热切换、用量/账户口径、阶段顺序、技术待验证项与验收标准。P0 技术结论与证据见 [P0-VERIFICATION.md](P0-VERIFICATION.md)。

## 开发时阅读

| 文档 | 用途 |
| --- | --- |
| [DEV-CON-PROPOSAL.md](DEV-CON-PROPOSAL.md) | 当前需求与验收的唯一依据，先读此文 |
| [P0-VERIFICATION.md](P0-VERIFICATION.md) | P0 七项的实现结论、可复现证据与未验证项 |
| [CONTEXT.md](../CONTEXT.md) | 领域词汇，辅助理解，不维护第二份计划 |
| [STRUCTURE.md](STRUCTURE.md) | 目录、依赖、实例数据和源码边界 |
| [根README](../README.md) | 安装/开发入口与项目导航 |

## 运维与交付规范

- [OPERATIONS.md](OPERATIONS.md)：安装与通用维护。
- [MODEL-ROUTING.md](MODEL-ROUTING.md)：DeepSeek 模型路由与官方事实的对齐记录（核对日期、来源、实例侧覆盖块）。
- [PM2-PRODUCTION.md](PM2-PRODUCTION.md)：正式服务管理及生产维护边界。
- [PM2-SHADOW.md](PM2-SHADOW.md)：隔离候选发布，不能当作生产升级入口。

上述文档约束各自工程操作，不增加本期功能，不自动授予上线或重启权限。

## 记录与历史材料

- [PERF-SESSION-LOAD.md](PERF-SESSION-LOAD.md)：会话加载/切换性能的实测基线、度量口径与优化分层（含未完成项）。
- [DEV-CON归档索引](history/dev-con/README.md)：旧评估、v1.2架构讨论和已移除原型的记录。
- [FOUNDATION-VALIDATION.md](FOUNDATION-VALIDATION.md)：指定基线的结构/性能验收，不是当前规划或在线状态证明。
- [PM2-CUTOVER.md](PM2-CUTOVER.md)：特定一次迁移记录，不是后续部署计划或授权。
- `history/`：早期环境与认证记录，仅供追溯。
- `vendor/pi-web-ui/docs/`：上游实现参考；PI-dev功能范围遵循当前开发基准，交付遵循根工程。

旧 SYSTEM-ARCHITECTURE-REVIEW、DEV-CON-ASSESSMENT、DEV-CON-IMPLEMENTATION 路径只保留跳转，不再与开发基准并列定义需求。未来范围变更先更新开发基准，再同步索引和摘要；旧记录不回写成“新计划”。

运行数据、凭据、日志和原始性能产物不进入文档目录。可公开的验证结论附在对应实现记录，详细测试产物存入忽略目录。
