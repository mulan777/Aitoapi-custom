# AIStudioToAPI Custom

这是基于 [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) 的公开二开版本。

## 二开内容

- 扩展模型列表配置，支持更多模型元数据与模型别名。
- 支持模型名后缀组合，用于思考等级、流式模式、联网搜索和代码执行等能力选择。
- 增强模型发现与请求转换逻辑。
- 增加思考等级与 `includeThoughts` / 输出配置的兼容处理。
- 保留上游的 OpenAI、Gemini、Anthropic 兼容接口和 Web 控制台。

## 安全说明

仓库不包含任何 Google 登录凭据、Auth JSON、API Key、控制台密码、代理凭据或运行统计数据。部署时请通过环境变量配置密钥，并将 `auth/`、`data/` 作为本地持久化目录挂载。

## 许可证

本项目沿用上游项目的 CC BY-NC 4.0 许可证。上游来源、许可证全文和原始版权声明请见仓库中的 `LICENSE` 文件。
