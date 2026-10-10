/**
 * 本地模型目录：可下载的 embedding / 图文（多模态）模型清单。
 *
 * 选择原则（对齐上游 dsh-knowledge 的 LOCAL_MODELS + 用户「更强 / 多模态」需求）：
 *  - 小模型（~30-130MB）开箱快，适合先验证链路；
 *  - 中文强模型（BGE zh / Qwen3）做主力检索；
 *  - CLIP 类图文模型（image-feature-extraction）支持「图片入库 + 文字搜图」，
 *    供知识库含图片的场景使用；文字仍用文本向量，图片用 CLIP 向量，二者维度不同
 *    时按 lane 区分（图片向量只在图片分块之间比较，避免跨模态维度混淆）。
 *
 * 维度与池化方式必须与 lib/onnx-runtime.js 的 poolingFor() 保持一致。
 */

/** 模型描述。sizeMB 为约数，仅用于 UI 展示预估下载量。 */
export const LOCAL_MODELS = [
  {
    id: 'Xenova/bge-small-zh-v1.5',
    name: 'BGE Small 中文 v1.5',
    kind: 'embedding',
    modality: 'text',
    subtitle: '512 维 · 中文检索强 · CLS 池化',
    dimensions: 512,
    maxTokens: 512,
    sizeMB: 95,
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    name: 'BGE Small 英文 v1.5',
    kind: 'embedding',
    modality: 'text',
    subtitle: '384 维 · 英文检索 · CLS 池化',
    dimensions: 384,
    maxTokens: 512,
    sizeMB: 130,
  },
  {
    id: 'Xenova/gte-small',
    name: 'GTE Small',
    kind: 'embedding',
    modality: 'text',
    subtitle: '384 维 · 多语言 · mean 池化',
    dimensions: 384,
    maxTokens: 512,
    sizeMB: 130,
  },
  {
    id: 'Xenova/multilingual-e5-small',
    name: 'Multilingual E5 Small',
    kind: 'embedding',
    modality: 'text',
    subtitle: '384 维 · 多语言 · CLS 池化',
    dimensions: 384,
    maxTokens: 512,
    sizeMB: 130,
  },
  {
    id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    name: 'Qwen3 Embedding 0.6B',
    kind: 'embedding',
    modality: 'text',
    subtitle: '1024 维 · 中文最强 · last-token 池化（推荐）',
    dimensions: 1024,
    maxTokens: 32768,
    sizeMB: 585,
    recommended: true,
  },
  // CLIP 图文模型：transformers.js 的 feature-extraction 管线对 CLIP 双塔 ONNX
  // 的文本分支兼容性未经验证（真机探针失败）。在图片入库管线（图像预处理 +
  // 双塔对齐 + 独立向量 lane）落地之前不对外提供，避免「下载成功但不可用」。
];

/** 重排序模型（可选增强）。 */
export const LOCAL_RERANKERS = [
  {
    id: 'Xenova/bge-reranker-base',
    name: 'BGE Reranker Base',
    kind: 'reranking',
    subtitle: '重排序 · 提升混合检索精度',
    sizeMB: 280,
  },
];

/** 按 id 查模型描述。 */
export function findLocalModel(id) {
  return LOCAL_MODELS.find((m) => m.id === String(id ?? '')) ?? null;
}

/** 下载页展示清单。 */
export function listDownloadable() {
  return [...LOCAL_MODELS, ...LOCAL_RERANKERS];
}

/** 校验 HuggingFace repo id 形状（防误填路径）。 */
export function validateModelId(id) {
  const s = String(id ?? '').trim();
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s) ? s : null;
}
