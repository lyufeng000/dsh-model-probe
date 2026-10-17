# 原生模型列表在线获取 · 0.1.0

透明增强 DSH 原有「设置 → 模型 → 获取可用模型」流程：普通获取立即读取配置和内置目录，只有显式点击「刷新 / 重试」才请求厂商。每个原生编辑器只有一个刷新按钮，打开选择弹窗后移入弹窗。

**没有独立“模型探测”设置页、卡片、手填表或额外的采用/写入流程。** 模型搜索、勾选、添加和保存仍由 DSH 原生界面负责。

## 行为

- 普通获取、挂载和重新打开编辑器只读最新静态配置与内置目录，不解析凭据、不访问网络、不等旧请求。
- 显式刷新才使用已有路由配置和凭据请求实时目录；不以静态目录或旧缓存冒充刷新成功。
- 刷新复用该提供商原有获取动作；保留已有勾选、搜索文本及请求期间的新操作，不自动添加、删除或保存模型。
- 刷新按钮沿用原生按钮样式，请求期间显示忙碌状态并避免重复触发。
- 失败由原生流程和刷新按钮提示报告；保留当前列表与选择，但不声称旧目录是本次刷新结果。
- **静态配置写入保留在原生保存流程中**：勾选、添加并保存后，由官方 ConfigEditor 写入当前 profile 的 `cordis.patch.yml`，不是仅把结果放进在线列表或缓存。
- 原生添加逻辑丢弃的 `reasoningEfforts` 会在官方保存锁内补齐；只补用户已选模型的缺失字段，保留现有顺序、容量、兼容配置、手工推理设置及其他路由。
- 思考能力按具体模型和实际协议映射，覆盖 Codex/OpenAI、Moonshot、xAI、Anthropic、Google、Mistral 和 OpenRouter。区分真实 effort、预算档位、开关、强制思考、明确不支持与未知；未知不写成 `false`，`ultra` 不冒充受支持档位。
- 普通保存无需先刷新即可补齐已确认的内置能力；手工映射、显式删除及自定义 serializer 配置保持优先。
- Gemini 4 Argon 的官方 LOW/MEDIUM/HIGH 需配套可逆请求修正，避免旧适配器把三档都发成自动预算。只作用于官方 Google 路由及精确型号，不改安装包、模型 ID、认证或重试。禁用插件也会卸载此修正；静态配置不会自行删除。
- 模型 ID、容量和模态来自厂商、已安装目录或明确核验的官方资料。Argon 依据 [官方模型说明](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon) 与 [思考参数文档](https://ai.google.dev/gemini-api/docs/thinking?hl=en)；用户既有容量不会被覆盖。
- 本地 Qwen 等自定义兼容服务，在未确认后端和聊天模板前不虚构多档能力。仅凭模型名称或 `reasoning: true` 不足以证明支持特定参数。

## 协议与安全

支持 Google Generative AI、OpenAI completions/responses、OpenAI Codex OAuth、Anthropic Messages 和 OpenRouter 的模型列表接口。Codex 读取已有有效登录记录，请求官方 `backend-api/codex/models`；不刷新或改写 OAuth 登录记录。

凭据只在 Host 内解析并发往当前路由配置的服务地址，前端不接收 key、token 或 account ID。保留凭据隔离、响应大小限制、超时、取消、禁止凭据重定向等检查。未授权的草稿地址/协议变更不能继承已存凭据。

只取一页；列出某个模型不等于已验证账号的实际推理权限。请求只获取目录，不发起模型推理。

## 使用与启用

1. 在 DSH 原生模型页配置该提供商的凭据或完成登录。
2. 确认本插件已启用。配置明确设置 `model-probe.disabled: true` 时，不会执行在线增强逻辑。
3. 在原生模型卡片点击「获取可用模型」，在原有弹窗搜索、勾选或点击「刷新 / 重试」。
4. 是否添加和保存始终由用户通过原生界面决定。

包名为 `dsh-live-model-probe`，仓库名为 `dsh-model-probe`。不要安装 npm 上其他作者的 `dsh-model-probe`。本地开发可将本仓库以 `link:` 形式登记为依赖。安装或改变插件启用状态须获得用户明确授权；插件不会自行启用自己。

## 开发与验证

```powershell
node --test test/*.test.mjs
```

普通 Node 测试覆盖零 I/O 静态发现、显式在线刷新、凭据隔离、全协议能力映射、原生保存、真实适配器离线序列化、单按钮迁移、重复点击保护、选择/搜索及请求中编辑保留、无额外页面和卸载清理。实际 DSH 集成测试须显式设置 `DSH_MODEL_TEST_RUNTIME`（DSH 0.2.1-rc.2 + pi-ai 1.1.0 的已解包运行时）和 `DSH_MODEL_TEST_ROOT`；离线推理清单测试须设置 `DSH_MODEL_TEST_INVENTORY`。缺少运行时条件时会标记跳过，不能将其算作通过。

可选的 `node scripts/browser-smoke.mjs` 需要安装开发依赖，并显式设置 `DSH_MODEL_TEST_ROOT`（临时输出目录）、`DSH_MODEL_TEST_RUNTIME`（已核对的 DSH 解包目录）。`DSH_MODEL_TEST_DEPS_ROOT` 可指定现有开发依赖目录，`DSH_MODEL_TEST_BROWSER` 可指定 Chrome。该测试使用安装版列表逻辑和 Modal 结构，图标/焦点层使用测试替身，厂商返回为合成数据；不连接用户账号、不冒充当前 GUI 验收。

弹窗增强依赖 DSH `0.2.1-rc.2` 已核对的原生 DOM 结构（按钮、弹窗标题、候选行、搜索框与 0.2.0 相同）；结构不匹配时保持原生界面，不接管输入或保存流程。新增厂商目录与真实推理权限仍需分别验证。

## 兼容性

- `package.json` 的 `engines.dsh` 限定 `>=0.2.1-rc.2 <0.3.0`。
- pi-ai 1.1.0 将 Azure 路由从 `azure-openai-responses` 更名为 `azure`。静态目录、原生保存和凭据引用仍可用；`azure-openai-responses` 协议没有可安全读取的在线列表接口，刷新会以 `AZURE_DISCOVERY_UNSUPPORTED` 明确拒绝（改用 `openai-completions` 的路由不受影响）。
- `.model-probe-cache/catalogs.json` 现为 v3，带 DSH/pi-ai 兼容纪元与 pi-ai 目录代次；旧 v2/旧纪元缓存只读忽略，不会进入原生保存。
- 备份文件保持 v1 结构，但新备份写入 `compat` 标记；升级前（无标记）的旧备份仍可列出，恢复会被 `LEGACY_BACKUP_UNSAFE` 明确拒绝，避免静默丢失 reasoningEfforts 或写入过期容量。
