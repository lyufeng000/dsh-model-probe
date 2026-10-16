# DSH 模型探测 · 0.1.0

在「设置 → 模型探测」中用 Host 已存 API key 查询厂商模型列表，与当前模型列表比较，然后通过官方配置编辑器预览、确认并采用。**列出模型不等于账号具备推理权限；本插件不调用推理接口。**

已验证环境：Windows，DSH `0.2.0-rc.2`，Cordis `4.0.4`，pi-ai `0.87.1`；内嵌 Node `24.18.1` 和普通 Node `24.21.0`。其他 DSH 版本尚未验证。

## 为什么不是点一下“获取可用模型”

官方页面当前读取的是运行时模型服务目录，而不是每次重新访问厂商 `/models`。pi-ai 随包携带静态目录；账户能用的模型、厂商实时目录和这个快照并不等价。只刷新页面不会更新包内目录。本插件不替换官方「模型」页、不修改 DSH 核心，也不把缺失模型自动删除。

## v1 支持范围

| 类型 | 模型列表请求 | 能力与限制 |
|---|---|---|
| Google Generative AI | `{base}/models?pageSize=1000`，`x-goog-api-key` | 仅保留 `generateContent`；读取厂商上下文/输出上限，不凭模型名推测图片能力 |
| OpenAI completions / responses、兼容网关 | `{base}/models`，Bearer API key | 标准 `data[]`，以及兼容的 `models[]` / `models{ID:信息}`；未知形状拒绝解析 |
| Anthropic Messages | `{base}/v1/models?limit=1000`，`x-api-key` + `anthropic-version` | 列表解析；未提供的容量留空或按下述来源补全 |
| OpenRouter | `{base}/models` | 可直接查询；也可显式勾选匿名参数补全 |
| OpenAI Codex OAuth | **不查询** | v1 只显示本地登录记录状态并手填模型参数；未验证发现端点，不能声称一键同步或查询成功 |
| 其他协议 | 不猜测 | 手填；兼容代理可显式选择已支持协议与地址后再查询 |

只取一页；识别到 `nextPageToken` / `has_more` 会标记列表可能不完整。不会自动翻页。空列表、认证失败、超时、格式不兼容不是删除现有模型的理由。

参数逐字段优先级：**厂商响应 > 同 provider 精确 ID 的内置目录 > 用户开启的匿名 OpenRouter 精确 ID 估算 > 手填 > 省略**。界面标注来源；不做跨厂商模糊匹配。用户在手填表中主动修订的值按手填内容采用。

## 使用

1. 先在官方「模型」页配置凭据或登录。插件没有 API key / token 输入框。
2. 打开「设置 → 模型探测」。普通 API 路由可查询，Codex 只有状态及手填区。
3. 查询不写配置。对兼容代理改地址会先提示是否向该地址发送当前路由的凭据；仅本次查询生效，不保存地址。
4. 勾选模型，或「载入勾选结果并修订」。手填区默认载入当前声明，支持 ID、名称、上下文、输出上限和 text/image 输入模态。数值必须是正整数；未知时留空。
5. 点「预览写入」，检查新增、移除、完整前后模型字段和来源。**采用是整体替换该路由列表，不是自动追加；要保留的旧模型必须仍在列表内。**
6. 再点「确认写入 profile」并确认弹窗。预览五分钟有效，单次使用；换选择、改手填内容或配置版本变化后需重新预览。
7. 「恢复内置目录」删除显式 `models` 键，绝不写成空数组；「查看模型备份」可预览并确认恢复目标路由的旧模型字段。

Codex 状态只区分缺记录、结构不支持、记录过期、读取失败或本地记录看似有效。**看似有效不等于在线授权或推理权限有效**。过期/缺记录请到官方「模型 → OpenAI Codex」重新登录；插件不刷新、不修改、也不发送 OAuth access/refresh token 或 account ID。

## 配置与安全边界

- Host 唯一写入入口为官方 `configEditor.edit`，锁内再次核对 revision；不自行拼接 YAML，不旁路写 profile。
- 仅改 `llm-pi-ai` 目标 provider 的 `models` / `modelOverrides`。采用显式列表时会先在预览中提示清除不兼容的旧 overrides，并将其备份。默认模型、其他路由、地址、凭据引用不变。
- 备份在 profile 的 `.model-probe-backups` 目录，只保存目标路由的白名单模型字段，不复制整份 YAML 或凭据。全局保留最近五份合法备份；成功和失败写入都尝试轮换。磁盘清理失败会明确提示，可能暂时超过五份；无关/损坏文件不擅自删除。
- 备份创建失败则不调用官方编辑器。备份含无法安全、无损保存的额外字段时拒绝写入，而不是静默截断。
- API key 仅在 Host 读取并发给用户确认的目标服务；禁用重定向，错误不回显响应正文、请求头或底层异常。已知本次 key 若被厂商回显到可展示字段则拒绝返回；这不构成任意编码/任意第三方敏感内容的 DLP 保证。
- 默认只允许 HTTPS；HTTP 仅允许 `localhost`、`127.0.0.1`、`[::1]`。地址禁止用户名、密码、查询参数和 fragment。用户仍须自行确认 HTTPS 自定义服务可信；不是全面的网络隔离/SSRF 沙箱。
- 默认 20 秒超时；响应及单份备份最大 4 MiB；列表最多 10000 项；支持取消和卸载释放。不自动刷新、不后台轮询。
- OpenRouter 参数补全默认关闭；开启后发独立匿名请求，不携带当前厂商 key，不上传模型列表或提示词；只在 Host 用精确 ID 对照，失败保留原厂商结果。
- Client/Host 协议版本不一致及 404/405 有完整重启提示。配置保存与热更新验证分别报告；保存成功后核对失败不会谎报“未保存”。

## 本地安装与升级

**必须先得到用户对当前 profile 安装/启用的明确确认。**这是未发布的本地包，不能按 npm 包名安装。

- 源码根目录作为 `link:<绝对源码目录>` 依赖登记。
- bundle 为 `dsh-model-probe`，通过包内 patch 挂载 `model-probe`，Host 条目 ID 为 `include:model-probe`。不要再在 profile patch 中重复 insert。
- 安装前备份相关 profile 文件；通过官方插件管理器处理本地 bundle，检查依赖/锁文件仅作增量改动，不运行未经同意的构建脚本。
- 同步插件治理账本、校验 JSON/YAML；本插件源码不放到治理目录或 DSH 安装目录中。
- 安装/Host 更新后由用户**完全退出并重新打开 DSH**，不只是刷新页面。代理不得自停当前宿主。模型配置正常保存并验证热更新成功时则不需要重启。
- 本地 link 插件只在“已安装”中出现，不会自动发布到 npm“发现”。

## 测试复现（PowerShell，源码根目录）

普通 Node 单元测试（五项 DSH 集成测试在缺少 runtime 变量时跳过）：

```powershell
$env:DSH_MODEL_TEST_ROOT = '<临时工作目录>'
node --test test/*.test.mjs
```

真实 DSH 集成测试，用实际安装路径替换以下变量。`DSH_MODEL_TEST_READ_PROFILE` **只读**，测试创建独立 Include/临时 profile，不写这个 profile。

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_MODEL_TEST_RUNTIME = '<DSH 安装目录>\resources\app.asar\dsh'
$env:DSH_MODEL_TEST_ROOT = '<临时工作目录>'
$env:DSH_MODEL_TEST_READ_PROFILE = "$env:USERPROFILE\.dsh\profiles\desktop"
& '<DSH 安装目录>\DeepSeek Harness.exe' --expose-internals --test --test-isolation=none test/*.test.mjs
```

真实浏览器测试复用这些变量，另可用 `DSH_MODEL_TEST_BROWSER` 指定 Chrome 可执行文件；默认 Windows Chrome 安装位置。测试开独立临时 profile 和 port 0 HTTP 服务，使用合成厂商响应，不使用真实 OAuth/API key；运行完释放临时 Host/浏览器，不替换当前 GUI。

```powershell
& '<DSH 安装目录>\DeepSeek Harness.exe' --expose-internals scripts/browser-smoke.mjs
```

测试需要 Electron ASAR 环境和 Chrome；普通 Node 不能代替 ASAR 集成运行器。临时输出在 `DSH_MODEL_TEST_ROOT`，截图/结果位置打印到日志；可复现的入口是 `scripts/browser-smoke.mjs`（历史验收脚本未随本仓库发布）。

## 验收证据与尚未验证

本轮开发的 P0–P5 验收报告、界面截图与测试/冒烟输出保存在作者本地，**未随本仓库发布**；下面列出仍然成立与尚未验证的边界。

未验证：所有厂商的真实账号、模型推理权限、Codex 在线模型发现、真实 ACL 拒绝写入、断电/磁盘满、真实原子替换失败后的系统恢复。备份目录不可用已用“同名普通文件”故障注入验证，不冒充 ACL 测试；官方 schema/overlay 拒绝和真实热更新另有集成证据。不能把隔离测试通过称为用户当前桌面已安装验收。
