# 认证闭环完成说明

本次接手并完成 `vendor/pi-web-ui` 的 Passkey 认证草稿：

- 会话令牌仅以 SHA-256 哈希写入 `webauthn.json`，内存中仍使用原始令牌校验。
- 注册和登录挑战在验证前一次性消费，阻止重放。
- 首次注册后禁止再次注册，避免未授权追加凭据。
- 认证 API 同时支持 `/api/auth/*` 与 `/dev/api/auth/*` 路径；现有服务端登录页同时支持 `/login` 与 `/dev/login`。
- 补充了认证类型与持久化哈希测试。

验证结果：认证单测修复后可运行；完整 `npm run typecheck` 仍被仓库既有 `server/agent-service.ts` 类型错误阻断（缺少 token-usage.mjs 声明、Conversation 类型缺少 lastSdkEventAt、缺少 fileURLToPath 导入），这些错误与本次认证改动无关。未修改 `8787` 或 `fayu`。
