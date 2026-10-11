# dsh-destinywind-rag

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**知识库 / RAG 插件**：本地优先的混合检索（BM25 + 向量 + RRF 融合），双向量引擎（大模型端点 + 本地模型），零配置开箱可用。

管理界面注册在**设置页【知识库】栏**，检索范围选择器出现在**对话输入框旁**。

---

## 特性

### 双向量引擎

| 类别 | 类型 | 说明 |
|---|---|---|
| 大模型向量引擎 | `openai` | OpenAI 兼容端点，填 endpoint / apiKey / model |
| 大模型向量引擎 | `custom` | 自定义 HTTP 端点 |
| 本地向量模型 | `onnx` | 内置 transformers.js + ONNX，**开箱即用，无需 Key** |
| 本地向量模型 | `ollama` | 本机 Ollama，**开箱即用，无需 Key** |
| 降级 | `none` | 纯 BM25 关键词检索（功能仍可用） |

- 每个知识库可独立绑定不同的 provider 与模型；一个 provider 可被多个知识库复用
- 切换模型后一键重建索引；提供连接测试、健康检查、维度校验
- 模型权重缓存在本地（默认 `<DSH_HOME>/cache/dsh-destinywind-rag/models`）

### 检索能力

- **混合检索**：BM25 关键词 + 向量语义 → RRF（倒数排名融合，K=60）
- **中文友好**：CJK 字符 bigram 分词（无需词典），FTS5 索引同步使用该分词
- **可选重排序**：远程 rerank API，失败自动降级为原始顺序，不阻断检索
- **MMR 去冗余**（可选）
- **结果注入前去重与截断**：同文档限条数 + 总字符预算
- 支持格式：**PDF、DOCX、PPTX、Markdown、TXT**（目录递归导入）

### 小白友好

- **零配置开箱可用**：首次调用自动创建「默认知识库」并自动选择 provider
- **优先级**：用户显式配置的端点 → 本机 Ollama → 内置本地 ONNX → 纯关键词
- 启动时静默检测本机 Ollama、API Key 环境变量、GPU 可用性
- 本地模型首次使用自动下载，带进度提示；失败给中文原因 + 替代方案按钮
- 所有配置在设置页【知识库】栏内完成，**无需手改配置文件**
- 任何失败都给**中文提示 + 修复建议**

### 调用方式

**方式一：输入框选择器**

对话输入框左侧的 `📚` 选择器可切换检索范围：

- **自动**（默认）—— 不限定知识库，由模型自行判断是否检索
- **全部知识库** —— 明确限定为全部
- **指定知识库** —— 只检索选中的库

选择结果同步给宿主，`knowledge_search` 未显式指定范围时遵循它。

**方式二：AI 自行调用**

`knowledge_search` 工具的 description 写清了触发条件，模型会自行判断是否需要检索。

**结果呈现**

回答中的检索结果带来源标注：`文件路径 + 页码/行号/段落`，UI 中可点击「打开原文件」。

---

## 安装

插件通过 GitHub 链接安装（不本地直接安装）：

```powershell
dsh plugin --profile <profile> add https://github.com/rickwindman/dsh-destinywind-rag
```

或使用包名（发布到 npm 后）：

```powershell
dsh plugin --profile <profile> add dsh-destinywind-rag
```

安装后重启 DSH，设置页会出现【知识库】栏。

---

## 使用方式示例

### 1. 零配置快速开始

1. 打开 **设置 → 知识库 → 知识库列表**
2. 点 **添加文件夹**，选择本地资料目录（如 `D:\Documents\产品资料`）
3. 插件自动解析其中的 PDF / DOCX / PPTX / MD / TXT 并建立索引
4. 在对话中直接提问，模型会按需调用 `knowledge_search`

无需任何配置——插件会自动检测本机 Ollama，没有则用内置 ONNX 模型（首次约 585 MB 下载）。

### 2. 配置大模型向量引擎

1. 进入 **向量模型** 标签页 → **＋ 新增 provider**
2. 类型选 `OpenAI 兼容端点`，填写：
   - Endpoint：`https://api.openai.com/v1`
   - API Key：`sk-...`（留空则读环境变量 `KNOWLEDGE_API_KEY` / `OPENAI_API_KEY`）
   - 模型名：`text-embedding-3-small`
3. 点 **测试连接** → 就地显示 `✓ 连接正常 · 184 ms` 与探测到的维度
4. 在下方 **知识库 ↔ 模型绑定** 表中点 **更换模型**，选该 provider
5. 确认弹窗「更换后需重建索引」→ 自动触发重建

#### 非对称模型（`input_type`）

部分向量模型是**非对称**的：文档与查询必须用不同的 `input_type` 编码，否则会直接报错或检索精度显著下降。典型代表是 NVIDIA NIM 的 `nv-embedqa` / `nemotron-embed` 系列。

在 provider 编辑弹窗的 **模型类型** 中选「非对称模型」即可：

- 建索引 / 重建索引 → 自动发送 `input_type: "passage"`
- 检索查询 → 自动发送 `input_type: "query"`
- 测试连接 → 自动发送 `input_type: "passage"`

普通 OpenAI、硅基流动等对称模型请保持默认「对称模型」（请求体不含该字段）。切换模型类型会改变向量空间，绑定的知识库会被标记为待重建。

### 3. 使用本机 Ollama

```powershell
ollama serve
ollama pull bge-m3
```

插件启动时会自动检测到 Ollama 并优先使用，无需手动配置。

### 4. 检索测试

**检索测试** 标签页：输入查询 → 选范围 → 检索。结果展示排名、相似度、BM25/向量分项分数、高亮命中片段、来源定位与耗时。

### 5. 状态查看

**状态** 标签页：本地模型下载进度（含取消）、环境检测报告（Ollama / ONNX / GPU / API Key / 缓存目录）、运行统计。

---

## 配置说明

部署默认值位于 `cordis.patch.yml` 的 `config:` 块；管理界面可在运行时覆盖并持久化，**大多数设置还支持按知识库覆盖**。

| 键 | 默认值 | 说明 |
|---|---|---|
| `embeddingProvider` | `auto` | `auto` \| `openai` \| `custom` \| `onnx` \| `ollama` \| `none` |
| `embeddingEndpoint` | `''` | OpenAI 兼容 / 自定义 HTTP 端点 |
| `embeddingApiKey` | `''` | 也可用环境变量 `KNOWLEDGE_API_KEY` |
| `embeddingModel` | `''` | 空 = 按 provider 自动选择 |
| `embeddingBatchSize` | `32` | 向量化批次大小（1–512） |
| `chunkSize` | `800` | 分块字符数（64–100000） |
| `chunkOverlap` | `100` | 分块重叠字符数 |
| `chunkSeparator` | `\n\n` | 优先切分的段落分隔符 |
| `smartChunk` | `true` | 超长段落按句子边界二次切分 |
| `topK` | `6` | 默认召回条数（1–50） |
| `searchMode` | `auto` | `auto` \| `hybrid` \| `vector` \| `lexical` |
| `similarityThreshold` | `0` | 相似度阈值（0–1） |
| `mmrDiversity` | `0` | MMR 多样性（0 = 关闭） |
| `rrfVectorWeight` | `1` | 向量路在 RRF 中的权重（0.1–5） |
| `siblingChunks` | `1` | 命中分块附带的相邻分块数 |
| `rerankEnabled` | `false` | 是否启用重排序 |
| `rerankEndpoint` | `''` | 重排序端点 |
| `rerankModel` | `''` | 重排序模型名 |
| `rerankApiKey` | `''` | 也可用 `KNOWLEDGE_RERANK_API_KEY` |
| `rerankTopN` | `20` | 参与重排序的候选数 |
| `autoRetrieve` | `true` | 未显式选择时由模型自行判断是否检索 |
| `injectUsagePrompt` | `true` | 是否在系统提示中列出可用知识库名 |
| `localModelCacheDir` | `''` | 空 = `<DSH_HOME>/cache/dsh-destinywind-rag/models` |
| `localModelIdleTimeoutMs` | `60000` | 本地模型空闲卸载时间（0 = 常驻） |
| `ollamaEndpoint` | `http://127.0.0.1:11434` | Ollama 端点 |
| `ollamaModel` | `bge-m3` | Ollama 默认模型 |
| `storePath` | `''` | 空 = `<DSH_HOME>/storages/destinywind-rag.sqlite` |

**API Key 读取顺序**：设置页填写 → `KNOWLEDGE_API_KEY` → `OPENAI_API_KEY`。

### 数据存储

| 内容 | 位置 |
|---|---|
| 知识库 / provider / 文档 / 分块 | `<DSH_HOME>/storages/destinywind-rag.sqlite`（SQLite + FTS5） |
| 本地模型权重 | `<DSH_HOME>/cache/dsh-destinywind-rag/models` |

数据库是标准 SQLite 文件，可用任意 SQLite 客户端读取；WAL 模式下可在运行时安全复制。

### HTTP API

浏览器半通过以下接口与宿主半通信（前缀 `/dsh-destinywind-rag`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 检测报告 + 下载进度 + 统计 |
| GET/POST | `/bases` | 列出 / 新建知识库 |
| PATCH/DELETE | `/bases/:id` | 重命名 / 删除 |
| POST | `/bases/:id/reindex` | 重建索引 |
| GET | `/bases/:id/dimension` | 维度校验 |
| GET/POST | `/documents` | 列出 / 导入（文本、文件、目录） |
| GET/POST | `/providers` | 列出（含绑定）/ 新建 provider |
| PATCH/DELETE | `/providers/:id` | 修改 / 删除 |
| POST | `/providers/:id/test` | 测试连接 |
| GET/POST | `/bindings` | 绑定关系表 / 绑定 provider |
| POST | `/search` | 检索 |
| GET/POST | `/scope` | 输入框选择器的检索范围 |
| GET | `/fs/list` | 目录浏览 |
| POST | `/models/download`、`/models/cancel` | 本地模型下载 / 取消 |

---

## 架构

```
index.js                     宿主半入口：HTTP API + knowledge_search 工具 + 系统提示
client.js                    浏览器半：设置页「知识库」栏 + 输入框选择器
lib/
  config.js                  配置默认值与三层合并（插件 → 运行时覆盖 → 每库覆盖）
  retrieval.js               纯逻辑：分词 / BM25 / 余弦 / RRF / MMR / 去重截断
  chunk.js                   分块：段落优先 → 句子兜底 → 合并 → 重叠
  embed.js                   provider 抽象层：单入口分发四类引擎 + 探测 + 维度校验
  onnx-runtime.js            本地 ONNX 运行时：按需加载 / 下载进度 / 取消 / 空闲卸载
  store.js                   SQLite + FTS5 + provider 注册表 + 多对多绑定
  parse.js                   PDF / DOCX / PPTX / Markdown / TXT 解析
  detect.js                  零配置环境检测与默认 provider 选择
  service.js                 服务编排：导入 → 索引 → 检索 → 重建
tests/                       单元测试 + 集成测试（112 个用例）
```

注册的 Slot（取自真实 Slot 树）：

- `settings.section` → 设置页【知识库】栏
- `conversation.input.left` → 对话输入框旁的知识库选择器

---

## 开发与验证

```powershell
# 运行全部测试
node --test

# 语法检查
node --check index.js
```

测试覆盖：

- **单元测试**：分词、BM25、余弦、RRF 融合、MMR、去重截断、分块、配置合并、维度校验、provider 工厂、embedding 分发与错误处理、存储层 CRUD 与多对多绑定
- **集成测试**：添加文档 → 索引 → 检索 → 返回来源；零配置开箱可用；大模型引擎链路；本地 Ollama 链路；维度校验与重建；重排序；文件与目录导入
- 远程端点用**本地 HTTP 桩服务器**验证，不访问外网

---

## 已知问题

1. **本地 ONNX 依赖需自行安装**：`@huggingface/transformers` 与 `onnxruntime-node` 是可选依赖。未安装时自动降级为 Ollama / 远程端点 / 纯关键词，并在状态页给出安装提示。
2. **PDF 解析依赖 pdfjs-dist**（或 pdf-parse），DOCX 需 `mammoth`，PPTX 需 `jszip`。缺失时导入会给出中文安装提示。
3. **扫描件 PDF 无 OCR**：纯图片 PDF 解析后文本为空，会提示「可能是扫描件」。OCR 能力未包含在本版本。
4. **本地 ONNX 默认模型约 585 MB**：首次使用需联网下载；离线环境建议改用 Ollama 或纯关键词模式。
5. **重排序仅支持远程 HTTP API**：未内置本地 bge-reranker（需额外 ONNX 运行时与模型下载）。
6. **向量检索为 JS 内余弦计算**：未使用 sqlite-vec 扩展。数万条分块规模下性能可接受；更大规模建议评估向量索引扩展。
7. **自定义 HTTP 端点目前按 OpenAI 兼容格式收发**：非标准端点需自行适配（`lib/embed.js` 的 `embedRemote`）。

---

## 来源与许可证

本项目为 **[Soren-ABT/dsh-knowledge](https://github.com/Soren-ABT/dsh-knowledge)**（v0.5.2，AGPL-3.0）的**二次开发**。

沿用了其以下设计（在 `lib/` 中按本机插件规范以纯 JS 重新实现）：

- BM25 参数（k1=1.5、b=0.75）与 `normalizeBm25` 归一化方式
- CJK 字符 bigram 分词策略
- RRF 融合（K=60）与每路权重调节
- MMR 去冗余算法
- `embedTexts(provider, baseUrl, model, apiKey, texts, signal)` 单入口抽象
- 模型族池化策略映射（Qwen3→last_token、BGE→cls、E5/GTE→mean）
- 本地模型治理经验（staging 校验、空闲卸载、取消语义）
- 三层配置合并（部署默认 → 运行时覆盖 → 每库覆盖）

**与原项目的差异**：本插件按 DSH 本机插件规范以**纯 JavaScript（ESM、零构建）** 实现，不依赖 TypeScript 构建链与 DSH 源码 checkout；并新增了 provider 独立实体与多对多绑定、零配置自动检测、输入框范围选择器、维度校验与「需重建」流程、全链路中文错误提示。

**许可证**：**AGPL-3.0**（沿用上游）。详见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
