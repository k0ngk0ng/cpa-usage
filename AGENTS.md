当前项目是基于 CLIProxyAPI(简称cpa) 做的 usage 统计程序 cpa-usage

CLIProxyAPI 代码在 https://github.com/router-for-me/CLIProxyAPI
已经同步到目录：/Users/jchen/Sources/github.com/router-for-me/CLIProxyAPI

该项目目的是能更好的观测 API 的使用情况

2026-07-13 usage token 语义核查：
- 以本地 CLIProxyAPI `origin/main` / `v7.2.72` 为准，队列中的 `tokens.input_tokens` 是 CPA 原样转发的上游 input/prompt 计数，不应全局理解为 `new/uncached`。
- OpenAI/Codex/OpenAI-compatible/Gemini 风格：`input_tokens`/`promptTokenCount` 通常已经是总输入，`cached_tokens`/`cachedContentTokenCount` 是其中的缓存命中部分；新输入应按 `input_tokens - cached_tokens` 估算，UI 不应再把二者相加为 Input。
- Claude/Anthropic 风格：`input_tokens` 是最后 cache breakpoint 之后的未缓存输入，总输入应为 `input_tokens + cache_read_tokens + cache_creation_tokens`。
- CPA 的 `cached_tokens` 不是可靠的“cache read”字段：Claude 解析在 read 为 0 时会 fallback 到 cache creation；有 `cache_read_tokens/cache_creation_tokens` 时优先使用这两个拆分字段。
- 当前修复策略：ingest 入口把新数据规范化为 `input_tokens=NEW`、`cached_tokens/cache_read_tokens=CACHE READ`、`cache_creation_tokens=CACHE WRITE`；历史数据用 `scripts/fix_usage_token_history.sh` 做同口径修复，脚本会先备份命中行。
- token 风格必须优先按队列 `executor_type`/精确 provider 判断，不能因 model 名含 `claude` 就判为 Anthropic；例如 Antigravity 承载 Claude 模型时仍是 Gemini 风格计数。
- CPA usage 是单次上游 provider call，同一个 `request_id` 可对应重试或附加模型的多条记录；`request_id` 不得作为数据库唯一键。
