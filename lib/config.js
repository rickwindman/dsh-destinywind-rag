/**
 * 插件配置：默认值 + 三层合并（插件 Config → 运行时覆盖 → 每知识库覆盖）。
 *
 * 与 dsh-knowledge 的 schemastery 方案等价，这里用纯 JS 实现，避免引入构建链。
 * 所有数值字段都做边界钳制，越界值回退到安全默认值而不是抛错——配置错误不该让插件启动失败。
 */

/** 向量引擎类型。大模型引擎：openai / custom；本地引擎：onnx / ollama；none = 纯关键词。 */
export const PROVIDER_KINDS = ['openai', 'custom', 'onnx', 'ollama', 'none'];

/** 大模型向量引擎（需要端点 + 密钥）。 */
export const REMOTE_KINDS = new Set(['openai', 'custom']);

/** 本地向量模型（开箱即用，无需密钥）。 */
export const LOCAL_KINDS = new Set(['onnx', 'ollama']);

/** 检索模式。auto 会按「有无可用向量」自动降级为 lexical。 */
export const SEARCH_MODES = ['auto', 'hybrid', 'vector', 'lexical'];

/** 内置本地 ONNX 默认模型：Qwen3-Embedding-0.6B，1024 维，约 585MB。 */
export const DEFAULT_ONNX_MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';

/** Ollama 默认端点与默认模型。 */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'bge-m3';

/** OpenAI 兼容端点默认值。 */
export const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';

/** 各 provider 的已知向量维度（探测失败时的兜底）。 */
export const KNOWN_DIMENSIONS = {
  [DEFAULT_ONNX_MODEL]: 1024,
  [DEFAULT_OLLAMA_MODEL]: 1024,
  [DEFAULT_OPENAI_MODEL]: 1536,
};

/** 插件 Config 默认值。 */
export const DEFAULTS = {
  embeddingProvider: 'auto',
  embeddingEndpoint: '',
  embeddingApiKey: '',
  embeddingModel: '',
  embeddingBatchSize: 32,
  chunkSize: 800,
  chunkOverlap: 100,
  chunkSeparator: '\n\n',
  smartChunk: true,
  topK: 6,
  searchMode: 'auto',
  similarityThreshold: 0,
  mmrDiversity: 0,
  rrfVectorWeight: 1,
  siblingChunks: 1,
  rerankEnabled: false,
  rerankEndpoint: '',
  rerankModel: '',
  rerankApiKey: '',
  rerankTopN: 20,
  autoRetrieve: true,
  injectUsagePrompt: true,
  localModelCacheDir: '',
  localModelIdleTimeoutMs: 60000,
  ollamaEndpoint: DEFAULT_OLLAMA_ENDPOINT,
  ollamaModel: DEFAULT_OLLAMA_MODEL,
  storePath: '',
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function pickString(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 把任意来源的原始配置规整成一份完整、边界安全的配置对象。
 * @param {object} raw 插件 Config（cordis.patch.yml 的 config 块）
 * @param {object} overrides 运行时覆盖（设置页写入，持久化在存储域）
 */
export function resolveConfig(raw = {}, overrides = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  // 覆盖优先，其次插件 Config，最后默认值。空字符串视为「未设置」，继续向下继承。
  const pick = (key) => {
    const ov = o[key];
    if (ov !== undefined && ov !== null && ov !== '') return ov;
    const rv = r[key];
    if (rv !== undefined && rv !== null && rv !== '') return rv;
    return DEFAULTS[key];
  };

  const chunkSize = clampInt(pick('chunkSize'), 64, 100000, DEFAULTS.chunkSize);
  const chunkOverlap = clampInt(pick('chunkOverlap'), 0, Math.max(0, chunkSize - 1), DEFAULTS.chunkOverlap);

  return {
    embeddingProvider: pickEnum(pick('embeddingProvider'), ['auto', ...PROVIDER_KINDS], DEFAULTS.embeddingProvider),
    embeddingEndpoint: pickString(pick('embeddingEndpoint'), DEFAULTS.embeddingEndpoint),
    embeddingApiKey: pickString(pick('embeddingApiKey'), DEFAULTS.embeddingApiKey),
    embeddingModel: pickString(pick('embeddingModel'), DEFAULTS.embeddingModel),
    embeddingBatchSize: clampInt(pick('embeddingBatchSize'), 1, 512, DEFAULTS.embeddingBatchSize),
    chunkSize,
    chunkOverlap,
    chunkSeparator: pickString(pick('chunkSeparator'), DEFAULTS.chunkSeparator),
    smartChunk: pickBool(pick('smartChunk'), DEFAULTS.smartChunk),
    topK: clampInt(pick('topK'), 1, 50, DEFAULTS.topK),
    searchMode: pickEnum(pick('searchMode'), SEARCH_MODES, DEFAULTS.searchMode),
    similarityThreshold: clampNumber(pick('similarityThreshold'), 0, 1, DEFAULTS.similarityThreshold),
    mmrDiversity: clampNumber(pick('mmrDiversity'), 0, 1, DEFAULTS.mmrDiversity),
    rrfVectorWeight: clampNumber(pick('rrfVectorWeight'), 0.1, 5, DEFAULTS.rrfVectorWeight),
    siblingChunks: clampInt(pick('siblingChunks'), 0, 3, DEFAULTS.siblingChunks),
    rerankEnabled: pickBool(pick('rerankEnabled'), DEFAULTS.rerankEnabled),
    rerankEndpoint: pickString(pick('rerankEndpoint'), DEFAULTS.rerankEndpoint),
    rerankModel: pickString(pick('rerankModel'), DEFAULTS.rerankModel),
    rerankApiKey: pickString(pick('rerankApiKey'), DEFAULTS.rerankApiKey),
    rerankTopN: clampInt(pick('rerankTopN'), 1, 100, DEFAULTS.rerankTopN),
    autoRetrieve: pickBool(pick('autoRetrieve'), DEFAULTS.autoRetrieve),
    injectUsagePrompt: pickBool(pick('injectUsagePrompt'), DEFAULTS.injectUsagePrompt),
    localModelCacheDir: pickString(pick('localModelCacheDir'), DEFAULTS.localModelCacheDir),
    localModelIdleTimeoutMs: clampInt(pick('localModelIdleTimeoutMs'), 0, 24 * 3600 * 1000, DEFAULTS.localModelIdleTimeoutMs),
    ollamaEndpoint: pickString(pick('ollamaEndpoint'), DEFAULTS.ollamaEndpoint),
    ollamaModel: pickString(pick('ollamaModel'), DEFAULTS.ollamaModel),
    storePath: pickString(pick('storePath'), DEFAULTS.storePath),
  };
}

/**
 * 解析某个知识库的有效配置：全局配置之上叠加该库自己的绑定与分块覆盖。
 * 空字段继承全局值——这与 dsh-knowledge 的「空字段继承」语义一致。
 * @param {object} global 已解析的全局配置
 * @param {object} baseConfig 该库的覆盖（可能为 undefined）
 */
export function resolveConfigForBase(global, baseConfig) {
  if (!baseConfig || typeof baseConfig !== 'object') return { ...global };
  const merged = { ...global };
  const keys = [
    'embeddingProvider', 'embeddingEndpoint', 'embeddingApiKey', 'embeddingModel',
    'chunkSize', 'chunkOverlap', 'topK', 'searchMode', 'similarityThreshold',
    'mmrDiversity', 'rrfVectorWeight', 'siblingChunks',
    'rerankEnabled', 'rerankEndpoint', 'rerankModel', 'rerankApiKey', 'rerankTopN',
  ];
  for (const key of keys) {
    const v = baseConfig[key];
    if (v === undefined || v === null || v === '') continue;
    merged[key] = v;
  }
  // 覆盖后重新钳制，避免每库覆盖绕过全局边界。
  merged.chunkSize = clampInt(merged.chunkSize, 64, 100000, DEFAULTS.chunkSize);
  merged.chunkOverlap = clampInt(merged.chunkOverlap, 0, Math.max(0, merged.chunkSize - 1), DEFAULTS.chunkOverlap);
  merged.topK = clampInt(merged.topK, 1, 50, DEFAULTS.topK);
  merged.searchMode = pickEnum(merged.searchMode, SEARCH_MODES, DEFAULTS.searchMode);
  merged.embeddingProvider = pickEnum(merged.embeddingProvider, ['auto', ...PROVIDER_KINDS], DEFAULTS.embeddingProvider);
  return merged;
}

/** 读取 API Key：覆盖 → 环境变量 → 插件 Config。环境变量名与 dsh-knowledge 保持兼容。 */
export function resolveApiKey(config, kind = 'embedding') {
  if (kind === 'rerank') {
    return config.rerankApiKey
      || process.env.KNOWLEDGE_RERANK_API_KEY
      || '';
  }
  return config.embeddingApiKey
    || process.env.KNOWLEDGE_API_KEY
    || process.env.OPENAI_API_KEY
    || '';
}
