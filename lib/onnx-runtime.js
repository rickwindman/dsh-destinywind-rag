/**
 * 本地 ONNX 运行时：transformers.js 加载 HuggingFace ONNX 模型，做本地向量化。
 *
 * 设计要点（对齐 dsh-knowledge 的本地模型治理经验）：
 *  - 模型按需加载并缓存，空闲超时后卸载以释放内存（默认 60s）；
 *  - 首次使用触发下载，带进度回调（状态页展示百分比）；
 *  - 支持取消：取消只中止进行中的传输，不动已完成的权重；
 *  - 池化策略按模型族选择（Qwen3→last_token、BGE→cls、E5/GTE→mean）；
 *  - 失败抛中文错误 + 修复建议，并给出替代方案（改 Ollama / 远程端点 / 纯关键词）。
 */

import { join } from 'node:path';
import { DEFAULT_ONNX_MODEL } from './config.js';
import { EmbeddingError } from './embed.js';

/** 各模型族的池化方式（与 Cherry Studio / dsh-knowledge 的约定一致）。 */
export function poolingFor(modelId) {
  const id = String(modelId ?? '').toLowerCase();
  if (id.includes('qwen3')) return 'last_token';
  if (id.includes('bge') || id.includes('bce')) return 'cls';
  if (id.includes('e5') || id.includes('gte')) return 'mean';
  return 'mean';
}

/**
 * 本地 ONNX 运行时。
 * 一个实例对应一个进程内的模型缓存；多个模型可共存，空闲后统一释放。
 */
export class OnnxRuntime {
  /**
   * @param {{cacheDir:string, idleTimeoutMs?:number, hfMirror?:string, onProgress?:(status:object)=>void}} options
   */
  constructor(options = {}) {
    this.cacheDir = String(options.cacheDir ?? '');
    this.idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : 60000;
    // HF 镜像（空 = 用默认 hf-mirror.com；HF_ENDPOINT 环境变量优先级更高）。
    this.hfMirror = String(options.hfMirror ?? '');
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    /** @type {Map<string, {extractor:object, dim:number, lastUsed:number}>} */
    this.loaded = new Map();
    /** @type {Map<string, {status:string, progress:number, message:string}>} */
    this.status = new Map();
    /** @type {Map<string, Promise<{extractor:object, dim:number}>>} 进行中的加载（并发去重）。 */
    this.inflight = new Map();
    this.idleTimer = null;
    this.cancelled = new Set();
  }

  /** 当前状态（供状态页轮询）。 */
  getStatus(modelId) {
    return this.status.get(String(modelId)) ?? {
      model: String(modelId),
      status: 'idle',
      progress: 0,
      message: '',
    };
  }

  listStatus() {
    return [...this.status.values()];
  }

  /** 清掉某模型的状态记录（缓存被删除后调用，避免状态页残留失败任务）。 */
  clearStatus(modelId) {
    this.status.delete(String(modelId));
    this.loaded.delete(String(modelId));
    this.inflight.delete(String(modelId));
    this.cancelled.delete(String(modelId));
    return { cleared: true };
  }

  #setStatus(modelId, status, progress, message) {
    const entry = { model: String(modelId), status, progress, message };
    this.status.set(String(modelId), entry);
    try {
      this.onProgress(entry);
    } catch {
      /* 进度回调失败不影响主流程 */
    }
  }

  /** 取消某模型的进行中下载。 */
  cancel(modelId) {
    const id = String(modelId);
    this.cancelled.add(id);
    const current = this.getStatus(id);
    if (current.status === 'downloading') {
      this.#setStatus(id, 'idle', 0, '已取消下载');
    }
    return { cancelled: true };
  }

  /** 是否正在下载。 */
  isDownloading(modelId) {
    return this.getStatus(modelId).status === 'downloading';
  }

  /** 触发空闲卸载定时器。 */
  #scheduleIdleUnload() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!(this.idleTimeoutMs > 0)) return;
    this.idleTimer = setTimeout(() => {
      this.unloadAll();
    }, this.idleTimeoutMs);
    // Node 进程不应因这个定时器而无法退出。
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  /** 释放全部已加载模型（内存回收，下次按需重载）。 */
  unloadAll() {
    for (const [modelId, entry] of this.loaded) {
      try {
        // transformers.js 的 pipeline 支持 dispose() 释放底层 ONNX session。
        entry.extractor?.dispose?.();
      } catch {
        /* 忽略释放失败 */
      }
      this.#setStatus(modelId, 'idle', 0, '已释放（空闲超时）');
    }
    this.loaded.clear();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * 加载模型（含首次下载）。返回 pipeline 实例与向量维度。
   * 并发去重：同一模型的并发首次调用共享同一个加载 Promise，
   * 否则会重复下载/加载并泄漏多余的 pipeline 实例。
   * @returns {Promise<{extractor:object, dim:number}>}
   */
  async #load(modelId) {
    const id = String(modelId || DEFAULT_ONNX_MODEL);
    const cached = this.loaded.get(id);
    if (cached) {
      cached.lastUsed = Date.now();
      this.#scheduleIdleUnload();
      return cached;
    }
    const pending = this.inflight.get(id);
    if (pending) return pending;

    const promise = this.#loadModel(id).finally(() => {
      this.inflight.delete(id);
    });
    this.inflight.set(id, promise);
    return promise;
  }

  /** 实际的加载流程（由 #load 保证同一模型同一时刻只有一个在跑）。 */
  async #loadModel(modelId) {
    const id = String(modelId || DEFAULT_ONNX_MODEL);

    if (this.cancelled.has(id)) this.cancelled.delete(id);

    let pipeline;
    try {
      const mod = await import('@huggingface/transformers');
      pipeline = mod.pipeline;
      // 缓存与镜像配置：
      //  - cacheDir 指到插件自己的位置，不污染用户全局 HF 缓存；
      //  - 镜像优先级：显式配置 > HF_ENDPOINT 环境变量 > hf-mirror.com（国内可达）。
      //    官方 huggingface.co 在多数国内网络不可达（实测超时），默认走镜像保证开箱可用。
      if (mod.env) {
        if (this.cacheDir) {
          mod.env.cacheDir = this.cacheDir;
        }
        const mirror = process.env.HF_ENDPOINT || this.hfMirror || 'https://hf-mirror.com/';
        mod.env.remoteHost = mirror.endsWith('/') ? mirror : `${mirror}/`;
        mod.env.remotePathTemplate = '{model}/resolve/{revision}/';
      }
    } catch (error) {
      this.#setStatus(id, 'error', 0, '运行时不可用');
      throw new EmbeddingError(
        `本地 ONNX 运行时不可用：${String(error?.message ?? error)}`,
        '请安装依赖：npm i @huggingface/transformers@4.3.1 onnxruntime-node@1.30.0；或改用 Ollama / 远程端点 / 纯关键词模式。',
      );
    }

    this.#setStatus(id, 'downloading', 0, '正在准备模型…');

    let extractor;
    try {
      extractor = await pipeline('feature-extraction', id, {
        dtype: 'fp32',
        progress_callback: (info) => {
          if (this.cancelled.has(id)) {
            // 标记取消后不再上报进度，由外层在返回后清理。
            return;
          }
          const pct = Number(info?.progress);
          const file = String(info?.file ?? '');
          if (Number.isFinite(pct)) {
            this.#setStatus(id, 'downloading', Math.round(pct), `正在下载 ${file || '模型权重'}`);
          } else if (info?.status === 'ready') {
            this.#setStatus(id, 'ready', 100, '模型就绪');
          }
        },
      });
    } catch (error) {
      if (this.cancelled.has(id)) {
        this.cancelled.delete(id);
        this.#setStatus(id, 'idle', 0, '已取消下载');
        throw new EmbeddingError('已取消模型下载', '可稍后重试，或改用 Ollama / 远程端点。');
      }
      const raw = String(error?.message ?? error);
      this.#setStatus(id, 'error', 0, raw);
      const isNetwork = /fetch|network|ENOTFOUND|ETIMEDOUT|socket|timeout/i.test(raw);
      throw new EmbeddingError(
        `本地模型加载失败：${raw}`,
        isNetwork
          ? '网络不可达。可设置环境变量 HF_ENDPOINT=https://hf-mirror.com 使用镜像源重试，或改用 Ollama / 远程端点。'
          : '请检查模型 id 是否正确、磁盘空间是否充足；也可改用 Ollama 或远程端点。',
      );
    }

    if (this.cancelled.has(id)) {
      this.cancelled.delete(id);
      try {
        extractor?.dispose?.();
      } catch {
        /* 忽略 */
      }
      this.#setStatus(id, 'idle', 0, '已取消下载');
      throw new EmbeddingError('已取消模型下载', '可稍后重试。');
    }

    // 用一条最小样本探出维度：比读取 config.json 更可靠（能同时验证模型真的可用）。
    let dim = 0;
    try {
      const probe = await this.#extract(extractor, id, ['维度探测']);
      dim = Array.isArray(probe?.[0]) ? probe[0].length : 0;
    } catch (error) {
      const raw = String(error?.message ?? error);
      // 常见原因分类，给出可执行的下一步（此前只说「探针失败」，用户无从下手）。
      const isClipLike = /clip|jina-clip/i.test(id);
      const suggestion = isClipLike
        ? '该模型是图文双塔（CLIP）结构，当前 feature-extraction 管线不兼容它的文本分支。请改用 BGE / GTE / E5 / Qwen3 等文本向量模型（本页清单内均为验证可用的）。'
        : /input|dim|shape|size/i.test(raw)
          ? '模型输入形状与管线不匹配：可能是模型变体与 transformers.js 版本不兼容。请改用清单内的推荐模型，或在「状态」页反馈。'
          : '模型文件可能不完整：请删除缓存目录后重试（目录见「状态」页「模型缓存目录」）；或改用 Ollama / 远程端点。';
      this.#setStatus(id, 'error', 0, raw.slice(0, 120));
      throw new EmbeddingError(`本地模型已下载但无法推理：${raw}`, suggestion);
    }

    const entry = { extractor, dim, lastUsed: Date.now() };
    this.loaded.set(id, entry);
    this.#setStatus(id, 'ready', 100, `模型就绪（${dim} 维）`);
    this.#scheduleIdleUnload();
    return entry;
  }

  /** 执行一次特征提取并做池化 + 归一化。 */
  async #extract(extractor, modelId, texts) {
    const pooling = poolingFor(modelId);
    const output = await extractor(texts, { pooling, normalize: true });
    // transformers.js 返回 Tensor，tolist() 得到嵌套数组。
    const list = typeof output?.tolist === 'function' ? output.tolist() : output;
    if (!Array.isArray(list)) {
      throw new Error('模型输出格式异常');
    }
    // 单条输入时 tolist() 可能返回一维数组，统一成二维。
    if (list.length > 0 && typeof list[0] === 'number') return [list];
    return list;
  }

  /**
   * 批量向量化（embedTexts 的 onnx 分支实现）。
   * @returns {Promise<number[][]>}
   */
  async embed(modelId, texts, options = {}) {
    const list = Array.isArray(texts) ? texts : [];
    if (list.length === 0) return [];
    if (options.signal?.aborted) throw new EmbeddingError('已取消向量化', '');

    const { extractor, dim } = await this.#load(modelId);
    const out = [];
    // 分批推理，避免一次性喂入过多文本导致内存峰值过高。
    const batchSize = Number.isFinite(options.batchSize) ? options.batchSize : 8;
    for (let i = 0; i < list.length; i += batchSize) {
      if (options.signal?.aborted) throw new EmbeddingError('已取消向量化', '');
      const group = list.slice(i, i + batchSize);
      const vectors = await this.#extract(extractor, modelId, group);
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length === 0) {
          throw new EmbeddingError('本地模型返回了空向量', '请检查模型是否兼容 transformers.js 的 feature-extraction 任务。');
        }
        out.push(v.map(Number));
      }
      const entry = this.loaded.get(String(modelId));
      if (entry) entry.lastUsed = Date.now();
    }
    this.#scheduleIdleUnload();
    // 维度与探针不一致说明模型行为异常，直接报错避免写出坏索引。
    if (dim > 0 && out.length > 0 && out[0].length !== dim) {
      throw new EmbeddingError(
        `本地模型输出维度不一致（探针 ${dim} 维，实际 ${out[0].length} 维）`,
        '请删除该模型的缓存目录后重新下载。',
      );
    }
    return out;
  }
}

/** 探测本地模型是否已下载（不加载模型，仅查文件）。 */
export async function probeOnnx(cacheDir, modelId) {
  const { isModelDownloaded } = await import('./detect.js');
  const downloaded = await isModelDownloaded(cacheDir, modelId);
  return downloaded
    ? { ok: true, latencyMs: 0, note: '权重已下载，首次调用时加载到内存。' }
    : { ok: false, latencyMs: 0, error: '模型权重尚未下载', suggestion: '首次使用时将自动下载；也可在「状态」页手动触发下载。' };
}
