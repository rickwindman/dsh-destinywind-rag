# 来源与许可声明（NOTICE）

## 上游项目

本插件 **dsh-destinywind-rag** 是以下开源项目的**二次开发（derivative work）**：

| 项 | 内容 |
|---|---|
| 项目 | dsh-knowledge |
| 作者 | Soren-ABT |
| 仓库 | https://github.com/Soren-ABT/dsh-knowledge |
| 版本 | v0.5.2 |
| 许可证 | AGPL-3.0 |
| 版权 | Copyright (C) Soren-ABT 及贡献者 |

## 沿用的设计

本插件在以下方面沿用（并在 `lib/` 中以纯 JavaScript 重新实现）了上游项目的设计：

| 设计点 | 本插件对应位置 |
|---|---|
| BM25 参数（k1=1.5、b=0.75）与 `normalizeBm25(raw) = raw/(raw+1)` | `lib/retrieval.js` |
| CJK 字符 bigram 分词（含单字回退） | `lib/retrieval.js` `tokenize()` |
| 倒数排名融合 RRF（K=60）与每路权重 | `lib/retrieval.js` `reciprocalRankFusion()` |
| 最大边际相关 MMR 去冗余 | `lib/retrieval.js` `maximalMarginalRelevance()` |
| `embedTexts(provider, baseUrl, model, apiKey, texts, signal)` 单入口抽象 | `lib/embed.js` `embedTexts()` |
| 模型族池化策略映射（Qwen3→last_token、BGE/BCE→cls、E5/GTE→mean） | `lib/onnx-runtime.js` `poolingFor()` |
| 本地模型治理（下载校验、空闲卸载、取消语义、隔离运行） | `lib/onnx-runtime.js` |
| 三层配置合并（部署默认 → 运行时覆盖 → 每库覆盖） | `lib/config.js` |
| SQLite + FTS5 存储与分块结构 | `lib/store.js` |
| 系统提示注入可用知识库名 | `index.js` |

## 与原项目的差异

本插件并非上游项目的直接 fork 产物，而是**架构层面的二次开发**：

- **实现语言**：按 DSH 本机插件规范以**纯 JavaScript（ESM、零构建）** 实现，不依赖 TypeScript 构建链，也不依赖 DSH 源码 checkout（上游的 `link:../dsh/packages/*` 在仅有安装包的机器上无法解析）。
- **新增能力**：
  - provider 独立实体 + 知识库↔provider **多对多绑定**（上游为每库内联字段）
  - **零配置自动检测**（Ollama → ONNX → 端点）与首次自动建库
  - 对话输入框旁的**知识库范围选择器**
  - **维度校验**与「需重建」流程
  - 全链路**中文错误提示 + 修复建议**
- **未包含**：上游的 MinerU 托管部署、OCR、图片/表格 caption、语义分块、URL 文档自动刷新等进阶能力。

## 许可证继承

依 AGPL-3.0 的传染性要求，本插件同样以 **AGPL-3.0** 发布。任何分发、修改或通过网络提供服务的行为，均须遵守 AGPL-3.0 条款（含提供完整对应源码的义务）。

完整许可证文本见 [LICENSE](LICENSE)。

## 第三方依赖

本插件运行时可选的第三方依赖及其许可证，由其各自项目提供：

| 依赖 | 用途 | 许可证 |
|---|---|---|
| `@huggingface/transformers` | 本地 ONNX 推理 | Apache-2.0 |
| `onnxruntime-node` | ONNX 运行时 | MIT |
| `pdfjs-dist` / `pdf-parse` | PDF 解析 | Apache-2.0 / MIT |
| `mammoth` | DOCX 解析 | BSD-2-Clause |
| `jszip` | PPTX 解析 | MIT |

以上依赖均为**可选**：未安装时插件自动降级，并在界面给出中文安装提示。
