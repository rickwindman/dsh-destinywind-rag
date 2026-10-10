/**
 * 零配置自动检测与默认 provider 选择。
 *
 * 优先级（与需求一致）：
 *   1. 用户手动配置了 OpenAI 兼容 / 自定义 HTTP 端点 → 用远程（显式配置优先）；
 *   2. 检测到本机 Ollama 在运行 → 用 Ollama；
 *   3. 内置本地 ONNX 模型 → 兜底（开箱即用，首次使用自动下载权重）；
 *   4. 全部不可用 → none（纯关键词检索，功能仍可用）。
 *
 * 启动时静默检测：Ollama 端口、API Key 环境变量、ONNX 运行时可用性、GPU 情况。
 * 任何一步失败都不抛错——降级继续，把原因记进结果供设置页展示。
 */

import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import {
  DEFAULT_OLLAMA_ENDPOINT,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_ONNX_MODEL,
  DEFAULT_OPENAI_ENDPOINT,
  DEFAULT_OPENAI_MODEL,
  KNOWN_DIMENSIONS,
} from './config.js';
import { probeOllama } from './embed.js';

/** 本地模型缓存根目录：<DSH_HOME>/cache/dsh-destinywind-rag/models */
export function defaultModelCacheDir() {
  const home = process.env.DSH_HOME ?? join(os.homedir(), '.dsh');
  return join(home, 'cache', 'dsh-destinywind-rag', 'models');
}

/** 解析本地模型缓存目录（配置为空时用默认值）。 */
export function resolveModelCacheDir(configured) {
  const s = String(configured ?? '').trim();
  return s !== '' ? s : defaultModelCacheDir();
}

/** 探测 API Key 环境变量（不读取值内容，只判断是否存在）。 */
export function detectApiKeyEnv() {
  const names = ['KNOWLEDGE_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];
  const found = names.filter((n) => {
    const v = process.env[n];
    return typeof v === 'string' && v.trim() !== '';
  });
  return { found, has: found.length > 0 };
}

/** 探测 ONNX 运行时是否可用（transformers.js + onnxruntime-node）。 */
export async function detectOnnxRuntime() {
  try {
    const mod = await import('@huggingface/transformers');
    if (typeof mod?.pipeline !== 'function') {
      return { ok: false, reason: '@huggingface/transformers 已安装但未导出 pipeline' };
    }
    return { ok: true, version: String(mod?.env?.version ?? 'unknown') };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/** 探测 GPU：onnxruntime-node 的可用执行提供器里是否含 CUDA / DML。 */
export async function detectGpu() {
  try {
    const ort = await import('onnxruntime-node');
    const available = typeof ort?.getAvailableExecutionProviders === 'function'
      ? await ort.getAvailableExecutionProviders()
      : [];
    const list = Array.isArray(available) ? available.map(String) : [];
    const gpuProviders = list.filter((p) => /cuda|dml|directml|rocm|tensorrt|coreml|webgpu/i.test(p));
    return { available: gpuProviders.length > 0, providers: list, gpuProviders };
  } catch (error) {
    return { available: false, providers: [], gpuProviders: [], reason: String(error?.message ?? error) };
  }
}

/** 检查本地模型权重是否已下载（config.json + onnx/*.onnx 非空）。 */
export async function isModelDownloaded(cacheDir, modelId) {
  const root = join(cacheDir, String(modelId));
  try {
    const cfg = await stat(join(root, 'config.json'));
    if (cfg.size <= 0) return false;
    const { readdir } = await import('node:fs/promises');
    const onnxDir = join(root, 'onnx');
    const entries = await readdir(onnxDir);
    for (const name of entries) {
      if (!name.endsWith('.onnx')) continue;
      const s = await stat(join(onnxDir, name));
      if (s.size > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 判断目录是否可写（模型缓存需要）。 */
export async function isWritableDir(dir) {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动时的静默检测：不抛错，返回一份可直接展示的检测报告。
 * @param {object} config 已解析配置
 * @param {{skipNetwork?:boolean}} options
 */
export async function detectEnvironment(config = {}, options = {}) {
  const cacheDir = resolveModelCacheDir(config.localModelCacheDir);
  const report = {
    checkedAt: Date.now(),
    ollama: { ok: false },
    onnx: { ok: false },
    gpu: { available: false },
    apiKey: detectApiKeyEnv(),
    modelCache: { dir: cacheDir, writable: false, downloaded: false },
    recommended: 'none',
    reasons: [],
  };

  // 1) Ollama：优先复用配置里的端点。
  if (options.skipNetwork !== true) {
    const endpoint = String(config.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT);
    const probe = await probeOllama(endpoint, { timeoutMs: 3000 });
    report.ollama = {
      ok: probe.ok === true,
      endpoint,
      models: probe.models ?? [],
      latencyMs: probe.latencyMs ?? 0,
      error: probe.error ?? '',
      suggestion: probe.suggestion ?? '',
    };
    if (!report.ollama.ok) report.reasons.push(`未检测到本机 Ollama：${report.ollama.error || '连接失败'}`);
  } else {
    report.reasons.push('已跳过网络检测（Ollama 未探测）');
  }

  // 2) ONNX 运行时。
  const onnx = await detectOnnxRuntime();
  const modelId = String(config.embeddingModel || DEFAULT_ONNX_MODEL);
  const cacheWritable = await isWritableDir(cacheDir);
  const downloaded = await isModelDownloaded(cacheDir, modelId);
  report.onnx = {
    ok: onnx.ok === true,
    reason: onnx.reason ?? '',
    model: modelId,
    downloaded,
  };
  report.modelCache = { dir: cacheDir, writable: cacheWritable, downloaded };
  if (!onnx.ok) report.reasons.push(`本地 ONNX 运行时不可用：${onnx.reason || '未安装'}`);

  // 3) GPU。
  report.gpu = await detectGpu();

  // 4) 推荐 provider：显式配置 > Ollama > ONNX > none。
  const configured = String(config.embeddingProvider || 'auto');
  if (configured !== 'auto' && configured !== 'none') {
    report.recommended = configured;
    report.reasons.push(`使用用户显式配置的向量引擎：${configured}`);
  } else if (report.ollama.ok) {
    report.recommended = 'ollama';
    report.reasons.push('检测到本机 Ollama 服务，优先使用本地 Ollama 向量模型。');
  } else if (report.onnx.ok) {
    report.recommended = 'onnx';
    report.reasons.push(report.onnx.downloaded
      ? '未检测到 Ollama，使用内置本地 ONNX 模型（权重已就绪）。'
      : '未检测到 Ollama，使用内置本地 ONNX 模型（首次使用将自动下载权重，约 585 MB）。');
  } else {
    report.recommended = 'none';
    report.reasons.push('未检测到可用的向量引擎，检索将使用纯关键词模式（BM25）。可在设置页配置端点或安装本地运行时。');
  }

  return report;
}

/**
 * 依据检测报告与配置，构造一个「可直接使用的 provider 规格」。
 * 用于零配置首次调用时自动创建默认知识库并绑定。
 * @returns {{kind:string, endpoint:string, model:string, apiKey:string, name:string, dim:number}}
 */
export function buildDefaultProviderSpec(config, report) {
  const kind = report?.recommended ?? 'none';
  if (kind === 'ollama') {
    const models = Array.isArray(report?.ollama?.models) ? report.ollama.models : [];
    // 优先挑一个 embedding 类模型；挑不到就用配置里的默认名（Ollama 会自行报错并给出 pull 提示）。
    const preferred = models.find((m) => /embed|bge|gte|e5|nomic/i.test(m)) ?? models[0] ?? '';
    return {
      kind: 'ollama',
      name: 'Ollama 本地',
      endpoint: String(config.ollamaEndpoint || report?.ollama?.endpoint || DEFAULT_OLLAMA_ENDPOINT),
      model: String(config.ollamaModel || preferred || DEFAULT_OLLAMA_MODEL),
      apiKey: '',
      dim: KNOWN_DIMENSIONS[DEFAULT_OLLAMA_MODEL] ?? 1024,
    };
  }
  if (kind === 'onnx') {
    return {
      kind: 'onnx',
      name: '本地 ONNX（内置）',
      endpoint: '',
      model: String(config.embeddingModel || DEFAULT_ONNX_MODEL),
      apiKey: '',
      dim: KNOWN_DIMENSIONS[DEFAULT_ONNX_MODEL] ?? 1024,
    };
  }
  if (kind === 'openai' || kind === 'custom') {
    return {
      kind,
      name: kind === 'openai' ? 'OpenAI 兼容端点' : '自定义 HTTP 端点',
      endpoint: String(config.embeddingEndpoint || (kind === 'openai' ? DEFAULT_OPENAI_ENDPOINT : '')),
      model: String(config.embeddingModel || DEFAULT_OPENAI_MODEL),
      apiKey: String(config.embeddingApiKey ?? ''),
      dim: KNOWN_DIMENSIONS[DEFAULT_OPENAI_MODEL] ?? 0,
    };
  }
  return { kind: 'none', name: '纯关键词（未配置向量引擎）', endpoint: '', model: '', apiKey: '', dim: 0 };
}
