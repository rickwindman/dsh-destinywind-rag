/**
 * Embedding provider 抽象层：单入口分发到四类引擎。
 *
 *   大模型向量引擎：openai（OpenAI 兼容 /embeddings）、custom（自定义 HTTP 端点）
 *   本地向量模型：  onnx（transformers.js，开箱即用）、ollama（本机 Ollama，开箱即用）
 *   降级：          none（不向量化，检索自动走纯 BM25）
 *
 * 关键设计：
 *  - embedTexts 是唯一入口，签名与 dsh-knowledge 对齐，便于对照与迁移；
 *  - 所有失败都抛中文错误（含修复建议），由上层转成用户可读提示；
 *  - 远程调用带超时与批次切分，避免单请求过大被端点拒绝。
 */

import { DEFAULT_ONNX_MODEL, DEFAULT_OLLAMA_ENDPOINT, DEFAULT_OPENAI_ENDPOINT, REMOTE_KINDS } from './config.js';

/** 默认超时：向量化单请求 30s；模型下载与加载不设此限（由调用方单独控制）。 */
const EMBED_TIMEOUT_MS = 30000;

/** 中文错误：包装底层异常，附修复建议。 */
export class EmbeddingError extends Error {
  constructor(message, suggestion) {
    super(message);
    this.name = 'EmbeddingError';
    this.suggestion = suggestion ?? '';
  }
}

function httpError(action, status, detail) {
  const hint = status === 401 || status === 403
    ? '请检查 API Key 是否正确、是否已过期。'
    : status === 404
      ? '请检查端点路径是否完整（OpenAI 兼容端点通常需要以 /v1 结尾）。'
      : status === 429
        ? '请求过于频繁或额度不足，请稍后重试或检查账户额度。'
        : status >= 500
          ? '服务端错误，请稍后重试或联系端点提供方。'
          : '请检查端点地址、网络连通性与请求参数。';
  return new EmbeddingError(`${action}失败（HTTP ${status}）${detail ? `：${detail}` : ''}`, hint);
}

function networkError(action, error) {
  const raw = String(error?.message ?? error);
  const isAbort = error?.name === 'AbortError' || /abort/i.test(raw);
  if (isAbort) {
    return new EmbeddingError(`${action}超时（超过 ${Math.round(EMBED_TIMEOUT_MS / 1000)} 秒）`, '请检查端点是否可达，或换用本地向量模型（无需联网）。');
  }
  return new EmbeddingError(`${action}网络错误：${raw}`, '请检查网络连接、代理设置与端点地址是否正确。');
}

/** 带超时的 fetch。 */
async function fetchWithTimeout(url, init, timeoutMs = EMBED_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 把数组按 size 切批。 */
export function batch(items, size) {
  const n = Math.max(1, Math.trunc(Number(size) || 1));
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** 规范化端点：去掉尾部斜杠。 */
export function normalizeEndpoint(endpoint) {
  const s = String(endpoint ?? '').trim();
  return s.endsWith('/') ? s.replace(/\/+$/, '') : s;
}

/**
 * 单入口：把文本批量向量化。
 * @param {object} spec 解析后的引擎规格 { kind, endpoint, model, apiKey }
 * @param {string[]} texts 待向量化文本
 * @param {{batchSize?:number, signal?:AbortSignal, onnxRuntime?:object}} options
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(spec, texts, options = {}) {
  const list = Array.isArray(texts) ? texts : [];
  if (list.length === 0) return [];
  const kind = String(spec?.kind ?? 'none');

  if (kind === 'none') {
    throw new EmbeddingError(
      '未配置向量引擎（当前为「纯关键词」模式）',
      '请在设置页「知识库 → 向量模型」中新增一个 provider，或使用内置本地模型。',
    );
  }

  if (kind === 'onnx') {
    const runtime = options.onnxRuntime;
    if (!runtime || typeof runtime.embed !== 'function') {
      throw new EmbeddingError(
        '本地 ONNX 运行时不可用',
        '请确认已安装 @huggingface/transformers 与 onnxruntime-node；也可改用 Ollama 或远程端点。',
      );
    }
    const model = String(spec.model || DEFAULT_ONNX_MODEL);
    return runtime.embed(model, list, { signal: options.signal });
  }

  if (kind === 'ollama') {
    return embedOllama(spec, list, options);
  }

  if (REMOTE_KINDS.has(kind)) {
    return embedRemote(kind, spec, list, options);
  }

  throw new EmbeddingError(`未知的向量引擎类型「${kind}」`, '请在设置页重新选择 provider 类型。');
}

/** OpenAI 兼容端点：POST {baseUrl}/embeddings。 */
async function embedRemote(kind, spec, texts, options) {
  const endpoint = normalizeEndpoint(spec.endpoint || (kind === 'openai' ? DEFAULT_OPENAI_ENDPOINT : ''));
  const model = String(spec.model ?? '').trim();
  if (endpoint === '') {
    throw new EmbeddingError('端点地址为空', '请在设置页填写 Endpoint，例如 https://api.openai.com/v1。');
  }
  if (model === '') {
    throw new EmbeddingError('模型名为空', '请在设置页填写模型名，例如 text-embedding-3-small。');
  }

  const url = `${endpoint}/embeddings`;
  const out = [];
  const batches = batch(texts, options.batchSize ?? 32);

  for (const group of batches) {
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(spec.apiKey ? { authorization: `Bearer ${spec.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: group, encoding_format: 'float' }),
      }, options.timeoutMs ?? EMBED_TIMEOUT_MS);
    } catch (error) {
      throw networkError('调用向量端点', error);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.text();
        detail = body.slice(0, 300);
      } catch {
        /* 读不到响应体就只报状态码 */
      }
      throw httpError('调用向量端点', res.status, detail);
    }

    let payload;
    try {
      payload = await res.json();
    } catch (error) {
      throw new EmbeddingError('向量端点返回的不是合法 JSON', '请确认该端点实现了 OpenAI 兼容的 /embeddings 接口。');
    }

    const data = Array.isArray(payload?.data) ? payload.data : null;
    if (data === null || data.length !== group.length) {
      throw new EmbeddingError(
        '向量端点返回的数据条数与请求不一致',
        '请确认端点返回 { data: [{ embedding: [...] }, ...] } 结构，且条数与输入一致。',
      );
    }
    // 按 index 排序，保证与输入顺序一致（部分端点会乱序返回）。
    const sorted = [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));
    for (const item of sorted) {
      const vector = item?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new EmbeddingError('向量端点返回了空的 embedding', '请确认模型名正确，且该模型支持 embeddings 接口。');
      }
      out.push(vector.map(Number));
    }
  }
  return out;
}

/**
 * 自定义 HTTP 端点：默认按 OpenAI 兼容格式发送，但允许通过 spec 定制。
 * 支持 spec.requestTemplate / responsePath 做非标准端点适配。
 */
async function embedOllama(spec, texts, options) {
  const endpoint = normalizeEndpoint(spec.endpoint || DEFAULT_OLLAMA_ENDPOINT);
  const model = String(spec.model ?? '').trim();
  if (model === '') {
    throw new EmbeddingError('Ollama 模型名为空', '请在设置页填写模型名，例如 bge-m3；或先执行 ollama pull bge-m3。');
  }

  const out = [];
  // Ollama 的 /api/embeddings 一次只接受一个 prompt，逐条发送。
  for (const text of texts) {
    let res;
    try {
      res = await fetchWithTimeout(`${endpoint}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
      }, options.timeoutMs ?? EMBED_TIMEOUT_MS);
    } catch (error) {
      throw networkError('调用 Ollama', error);
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* 忽略 */
      }
      if (res.status === 404) {
        throw new EmbeddingError(
          `Ollama 中找不到模型「${model}」（HTTP 404）`,
          `请先执行：ollama pull ${model}`,
        );
      }
      throw httpError('调用 Ollama', res.status, detail);
    }

    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new EmbeddingError('Ollama 返回的不是合法 JSON', '请确认 Ollama 服务版本支持 /api/embeddings。');
    }
    const vector = payload?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new EmbeddingError('Ollama 返回了空的 embedding', `请确认模型「${model}」是 embedding 模型。`);
    }
    out.push(vector.map(Number));
  }
  return out;
}

/**
 * 探测远程端点可用性与向量维度：发一条最小请求。
 * @returns {Promise<{ok:boolean, dim?:number, latencyMs:number, error?:string, suggestion?:string}>}
 */
export async function probeRemote(spec, options = {}) {
  const started = Date.now();
  try {
    const vectors = await embedTexts(spec, ['维度探测'], { batchSize: 1, timeoutMs: options.timeoutMs ?? 15000 });
    const dim = vectors?.[0]?.length ?? 0;
    return { ok: true, dim, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: String(error?.message ?? error),
      suggestion: String(error?.suggestion ?? ''),
    };
  }
}

/** 探测 Ollama：GET /api/tags，列出已安装模型。 */
export async function probeOllama(endpoint, options = {}) {
  const started = Date.now();
  const base = normalizeEndpoint(endpoint || DEFAULT_OLLAMA_ENDPOINT);
  try {
    const res = await fetchWithTimeout(`${base}/api/tags`, { method: 'GET' }, options.timeoutMs ?? 5000);
    if (!res.ok) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: `Ollama 返回 HTTP ${res.status}`,
        suggestion: '请确认 Ollama 服务正在运行（ollama serve）。',
      };
    }
    const payload = await res.json();
    const models = Array.isArray(payload?.models)
      ? payload.models.map((m) => String(m?.name ?? m?.model ?? '')).filter(Boolean)
      : [];
    return { ok: true, latencyMs: Date.now() - started, models };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: `无法连接 Ollama：${String(error?.message ?? error)}`,
      suggestion: `请确认 Ollama 已安装并启动（默认 ${DEFAULT_OLLAMA_ENDPOINT}）。`,
    };
  }
}

/** L2 归一化（余弦检索前置处理）。 */
export function normalizeVector(vector) {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vector.map(() => 0);
  return vector.map((v) => v / norm);
}

/**
 * 维度校验：比对模型输出维度与已建索引维度。
 * @returns {{status:'ok'|'mismatch'|'unknown', modelDim:number, indexDim:number, message:string}}
 */
export function checkDimension(modelDim, indexDim) {
  const m = Number(modelDim) || 0;
  const i = Number(indexDim) || 0;
  if (m <= 0) {
    return { status: 'unknown', modelDim: m, indexDim: i, message: '模型维度未知，请先执行「测试连接」以探测维度。' };
  }
  if (i <= 0) {
    return { status: 'ok', modelDim: m, indexDim: i, message: `尚未建立索引，将按 ${m} 维建立。` };
  }
  if (m !== i) {
    return {
      status: 'mismatch',
      modelDim: m,
      indexDim: i,
      message: `模型输出 ${m} 维，与已建索引 ${i} 维不一致，需重建索引。`,
    };
  }
  return { status: 'ok', modelDim: m, indexDim: i, message: `维度一致（${m} 维）。` };
}
