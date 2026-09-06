# Release v1.2.1

发布日期：2026-09-06

## 重点更新

- 增加凭证手动启用/禁用，保留禁用原因、状态码和时间。
- 对可配置的 401/403 等状态码执行自动禁用，避免坏凭证反复进入轮询池。
- 增加在线可持久化的 `MAX_RETRIES`、`RETRY_DELAY`、`AUTO_DISABLE_STATUS_CODES`、`MAX_CONTEXTS`、`ACCOUNT_COOLDOWN_MS` 和 `ACCOUNT_COOLDOWN_MAX_MS` 设置。
- 将 429 冷却粒度改为“凭证 + 原始模型”；单个模型冷却时，同一凭证的其他模型仍可继续调用。
- 在凭证列表持续显示正在冷却的模型、截止时间和剩余时间。
- 增加凭证级今日成功/失败统计，并按模型拆分。
- 修复多上下文轮询中的竞态：新账号上下文和 WebSocket 就绪后才替换旧上下文，减少浏览器反复重启。
- 修复并发禁用清理和上下文初始化冲突。
- 恢复模型后缀变体、thinking/real/fake 相关请求处理与流式输出保护。
- 将 `gemini-3.8-flash` 补入模型列表。
- 增加路由、后台唤醒、模型后缀和流完整性回归测试。
- Docker 工作流支持 tag 触发的 `linux/amd64` 与 `linux/arm64` 镜像构建并发布到 GHCR。

## 验证

- `npm run test:routing`：PASS
- `npm run test:background-wakeup`：PASS
- `npm run test:model-suffix`：PASS
- `npm run test:stream-integrity`：PASS
- `npm run lint:js`：通过，仅保留既有 `vue/no-v-html` 警告
- `npm run build:ui`：PASS
- `git diff --check`：PASS

## 升级提示

- 多账号同时在线时设置 `MAX_CONTEXTS`，例如 `MAX_CONTEXTS=5`。
- 60 个凭证不等于 60 个同时打开的浏览器上下文；系统会维持最多 `MAX_CONTEXTS` 个热上下文，其余凭证作为候选池按需替换。
- Docker 运行时请持久化 `configs/auth` 与 `data`，并使用 `--restart unless-stopped`。
