/**
 * 服务编排层：把存储、解析、分块、向量化、检索串成完整业务流。
 *
 * 职责：
 *  - 知识库 / provider / 绑定的增删改查（含零配置自动初始化）；
 *  - 导入文档：解析 → 分块 → 向量化 → 落库（含去重与维度校验）；
 *  - 检索：候选加载 → FTS 预筛 → BM25 + 向量 → RRF 融合 → 可选重排 → 去重截断；
 *  - 重建索引：模型/维度变更后按新配置重算全部向量；
 *  - 连接测试与维度校验。
 *
 * 所有对外方法失败时抛带 suggestion 的错误，由 HTTP 层转成中文提示。
 */

import { KnowledgeStore, contentHash } from './store.js';
import { chunkText, lineNumberAt } from './chunk.js';
import { rank, dedupeAndTruncate, explainHit } from './retrieval.js';
import { embedTexts, probeRemote, probeOllama, checkDimension, EmbeddingError, normalizeEndpoint } from './embed.js';
import { parseFile, locatePages, pageAt, isSupported, ParseError } from './parse.js';
import { OnnxRuntime, probeOnnx } from './onnx-runtime.js';
import { resolveConfig, resolveConfigForBase, resolveApiKey, DEFAULT_ONNX_MODEL, DEFAULT_OLLAMA_ENDPOINT, DEFAULT_OPENAI_ENDPOINT } from './config.js';
import { detectEnvironment, buildDefaultProviderSpec, resolveModelCacheDir } from './detect.js';

export class KnowledgeService {
  /**
   * @param {object} rawConfig 插件 Config（cordis.patch.yml）
   */
  constructor(rawConfig = {}) {
    this.rawConfig = rawConfig;
    this.store = new KnowledgeStore(rawConfig.storePath);
    this.onnx = new OnnxRuntime({
      cacheDir: resolveModelCacheDir(rawConfig.localModelCacheDir),
      idleTimeoutMs: Number(rawConfig.localModelIdleTimeoutMs ?? 60000),
    });
    this.detectReport = null;
  }

  /** 当前全局配置（叠加存储域里的运行时覆盖）。 */
  config() {
    const overrides = this.store.getSetting('configOverrides', {}) ?? {};
    return resolveConfig(this.rawConfig, overrides);
  }

  /** 保存运行时配置覆盖（设置页写入）。 */
  saveOverrides(patch) {
    const current = this.store.getSetting('configOverrides', {}) ?? {};
    const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
    // 空字符串表示「恢复继承」，从覆盖里删掉而不是存空值。
    for (const [k, v] of Object.entries(next)) {
      if (v === '' || v === undefined || v === null) delete next[k];
    }
    this.store.setSetting('configOverrides', next);
    return this.config();
  }

  // ───────────────────────── 零配置初始化 ─────────────────────────

  /**
   * 静默检测环境并缓存结果。启动时调用一次即可。
   */
  async detect(options = {}) {
    this.detectReport = await detectEnvironment(this.config(), options);
    return this.detectReport;
  }

  /**
   * 确保有一个可用的默认知识库与 provider（零配置开箱可用）。
   * 首次调用时自动创建；已有数据时直接复用。
   * @returns {Promise<{base:object, provider:object|null, created:boolean}>}
   */
  async ensureDefault() {
    const existing = this.store.listBases();
    if (existing.length > 0) {
      const base = existing[0];
      const provider = this.store.getActiveProvider(base.id);
      if (provider) return { base, provider, created: false };
      // 有知识库但没有 provider：补一个默认绑定。
      const report = this.detectReport ?? await this.detect();
      const spec = buildDefaultProviderSpec(this.config(), report);
      const created = this.#ensureProviderFromSpec(spec);
      if (created) this.store.bindProvider(base.id, created.id, 'embedding');
      return { base, provider: created, created: false };
    }

    const report = this.detectReport ?? await this.detect();
    const spec = buildDefaultProviderSpec(this.config(), report);
    const provider = this.#ensureProviderFromSpec(spec);
    const base = this.store.createBase({
      name: '默认知识库',
      description: '首次使用时自动创建；可在「知识库列表」中重命名或删除。',
      providerId: provider?.id,
    });
    return { base, provider, created: true };
  }

  /** 按规格找到或创建一个 provider（避免重复创建同类型默认项）。 */
  #ensureProviderFromSpec(spec) {
    if (!spec || spec.kind === 'none') return null;
    const all = this.store.listProviders();
    const same = all.find((p) => p.kind === spec.kind && p.model === spec.model && p.endpoint === spec.endpoint);
    if (same) return same;
    return this.store.createProvider({
      kind: spec.kind,
      name: spec.name,
      endpoint: spec.endpoint,
      model: spec.model,
      apiKey: spec.apiKey,
      dim: spec.dim,
      status: 'unknown',
    });
  }

  // ───────────────────────── provider ─────────────────────────

  listProviders() {
    return this.store.listProviders();
  }

  createProvider(input) {
    const kind = String(input?.kind ?? 'onnx');
    const provider = this.store.createProvider({
      kind,
      name: String(input?.name ?? '').trim() || defaultProviderName(kind),
      endpoint: kind === 'onnx' ? '' : String(input?.endpoint ?? ''),
      apiKey: String(input?.apiKey ?? ''),
      model: String(input?.model ?? '') || defaultModelFor(kind),
      dim: Number(input?.dim ?? 0) || 0,
    });
    return provider;
  }

  updateProvider(id, patch) {
    const current = this.store.getProvider(id);
    if (!current) throw new EmbeddingError('provider 不存在', '请刷新页面后重试。');
    const kind = String(patch?.kind ?? current.kind);
    return this.store.updateProvider(id, {
      kind,
      name: String(patch?.name ?? current.name),
      endpoint: kind === 'onnx' ? '' : String(patch?.endpoint ?? current.endpoint),
      apiKey: patch?.apiKey === undefined ? current.apiKey : String(patch.apiKey),
      model: String(patch?.model ?? current.model),
      dim: Number(patch?.dim ?? current.dim) || 0,
      enabled: patch?.enabled === undefined ? current.enabled : patch.enabled !== false,
    });
  }

  deleteProvider(id) {
    return this.store.deleteProvider(id);
  }

  /**
   * 测试 provider 连接，结果落库（状态灯 + 延迟 + 中文错误）。
   * @returns {Promise<{ok:boolean, latencyMs:number, dim?:number, error?:string, suggestion?:string}>}
   */
  async testProvider(id) {
    const provider = this.store.getProvider(id);
    if (!provider) throw new EmbeddingError('provider 不存在', '请刷新页面后重试。');
    const config = this.config();
    const spec = {
      kind: provider.kind,
      endpoint: provider.endpoint,
      model: provider.model,
      apiKey: provider.apiKey || resolveApiKey(config),
    };

    let result;
    if (provider.kind === 'onnx') {
      const cacheDir = resolveModelCacheDir(config.localModelCacheDir);
      const probe = await probeOnnx(cacheDir, spec.model || DEFAULT_ONNX_MODEL);
      result = probe.ok
        ? { ok: true, latencyMs: 0, dim: provider.dim || 0 }
        : { ok: false, latencyMs: 0, error: probe.error, suggestion: probe.suggestion };
    } else if (provider.kind === 'ollama') {
      const probe = await probeOllama(spec.endpoint || config.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT);
      if (!probe.ok) {
        result = { ok: false, latencyMs: probe.latencyMs, error: probe.error, suggestion: probe.suggestion };
      } else {
        // Ollama 在线，再验证目标模型是否已 pull。
        const has = (probe.models ?? []).some((m) => m === spec.model || m.startsWith(`${spec.model}:`));
        result = has
          ? { ok: true, latencyMs: probe.latencyMs, dim: provider.dim || 0 }
          : {
              ok: false,
              latencyMs: probe.latencyMs,
              error: `Ollama 在线，但未找到模型「${spec.model}」`,
              suggestion: `请执行：ollama pull ${spec.model}`,
            };
      }
    } else if (provider.kind === 'none') {
      result = { ok: true, latencyMs: 0, dim: 0 };
    } else {
      result = await probeRemote(spec);
    }

    this.store.recordProviderStatus(id, result);
    if (result.ok && Number(result.dim) > 0) {
      this.store.updateProvider(id, { dim: Number(result.dim) });
    }
    return result;
  }

  // ───────────────────────── 绑定与维度 ─────────────────────────

  listBindings() {
    return this.store.listBindings();
  }

  /** 把知识库绑定到某 provider；维度不一致时标记需重建。 */
  bindProvider(baseId, providerId, role = 'embedding') {
    const base = this.store.getBase(baseId);
    if (!base) throw new EmbeddingError('知识库不存在', '请刷新页面后重试。');
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new EmbeddingError('provider 不存在', '请刷新页面后重试。');

    this.store.bindProvider(baseId, providerId, role);
    const check = checkDimension(provider.dim, base.indexDim);
    if (check.status === 'mismatch') this.store.setBaseStatus(baseId, 'stale');
    return { base: this.store.getBase(baseId), provider, dimension: check };
  }

  /** 维度校验：模型输出维度 vs 已建索引维度。 */
  checkBaseDimension(baseId) {
    const base = this.store.getBase(baseId);
    if (!base) throw new EmbeddingError('知识库不存在', '请刷新页面后重试。');
    const provider = this.store.getActiveProvider(baseId);
    if (!provider) {
      return { status: 'unknown', modelDim: 0, indexDim: base.indexDim, message: '该知识库尚未绑定向量模型。' };
    }
    return checkDimension(provider.dim, base.indexDim);
  }

  // ───────────────────────── 知识库 CRUD ─────────────────────────

  listBases() {
    return this.store.listBases().map((base) => {
      const provider = this.store.getActiveProvider(base.id);
      const check = provider ? checkDimension(provider.dim, base.indexDim) : null;
      return {
        ...base,
        providerId: provider?.id ?? null,
        providerName: provider?.name ?? '',
        providerKind: provider?.kind ?? '',
        model: provider?.model ?? '',
        dimension: check,
      };
    });
  }

  createBase(input) {
    const base = this.store.createBase({
      name: String(input?.name ?? '').trim() || '新建知识库',
      description: String(input?.description ?? ''),
    });
    if (input?.providerId) this.bindProvider(base.id, String(input.providerId));
    return this.store.getBase(base.id);
  }

  renameBase(id, name) {
    const trimmed = String(name ?? '').trim();
    if (trimmed === '') throw new EmbeddingError('知识库名称不能为空', '请输入一个名称。');
    return this.store.renameBase(id, trimmed);
  }

  deleteBase(id) {
    return this.store.deleteBase(id);
  }

  // ───────────────────────── 导入 ─────────────────────────

  /**
   * 导入一段纯文本。
   */
  async addText(input) {
    const baseId = String(input?.baseId ?? '');
    const text = String(input?.text ?? '');
    if (text.trim() === '') throw new EmbeddingError('文档内容为空', '请提供要导入的文本内容。');
    return this.#ingest({
      baseId,
      text,
      title: String(input?.title ?? '未命名文档'),
      sourceType: 'text',
      sourcePath: '',
      mimeType: 'text/plain',
      pageCount: 0,
    });
  }

  /**
   * 导入一个文件（PDF/DOCX/PPTX/MD/TXT）。
   */
  async addFile(input) {
    const filePath = String(input?.filePath ?? '');
    if (!isSupported(filePath)) {
      throw new ParseError(
        `不支持的文件类型：${filePath}`,
        '当前支持 PDF、DOCX、PPTX、Markdown、TXT。',
      );
    }
    const parsed = await parseFile(filePath);
    return this.#ingest({
      baseId: String(input?.baseId ?? ''),
      text: parsed.text,
      title: String(input?.title ?? parsed.title),
      sourceType: 'file',
      sourcePath: filePath,
      mimeType: parsed.mimeType,
      pageCount: parsed.pageCount,
    });
  }

  /**
   * 导入一个目录（递归，跳过不支持的文件）。
   * @returns {Promise<{imported:number, skipped:number, failed:Array<{path:string,error:string}>}>}
   */
  async addDirectory(input) {
    const { readdir } = await import('node:fs/promises');
    const dir = String(input?.dirPath ?? '');
    const baseId = String(input?.baseId ?? '');
    const result = { imported: 0, skipped: 0, failed: [] };

    const walk = async (current) => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        result.failed.push({ path: current, error: `无法读取目录：${String(error?.message ?? error)}` });
        return;
      }
      for (const entry of entries) {
        const full = `${current}\\${entry.name}`.replace(/\\\\/g, '\\');
        if (entry.isDirectory()) {
          // 跳过常见噪声目录，避免把 node_modules 之类也索引进来。
          if (/^(node_modules|\.git|\.cache|dist|build|__pycache__|\.venv|venv)$/i.test(entry.name)) continue;
          await walk(full);
          continue;
        }
        if (!isSupported(full)) {
          result.skipped += 1;
          continue;
        }
        try {
          const r = await this.addFile({ baseId, filePath: full });
          if (r.skipped) result.skipped += 1;
          else result.imported += 1;
        } catch (error) {
          result.failed.push({ path: full, error: String(error?.message ?? error) });
        }
      }
    };

    await walk(dir);
    return result;
  }

  /** 导入核心：解析结果 → 分块 → 向量化 → 落库。 */
  async #ingest(input) {
    const baseId = String(input.baseId ?? '');
    const base = this.store.getBase(baseId);
    if (!base) throw new EmbeddingError('知识库不存在', '请先在「知识库列表」中创建或选择一个知识库。');

    const config = resolveConfigForBase(this.config(), null);
    const chunks = chunkText(input.text, {
      chunkSize: config.chunkSize,
      chunkOverlap: config.chunkOverlap,
      separator: config.chunkSeparator,
      smartChunk: config.smartChunk,
    });
    if (chunks.length === 0) {
      throw new EmbeddingError('文档解析后没有可用文本', '该文件可能是扫描件或空文件；可尝试其它文件，或改用支持 OCR 的解析器。');
    }

    // 页码回填（PDF/PPTX 有页标记时）。
    const pageMarks = locatePages(input.text);
    const provider = this.store.getActiveProvider(baseId);
    const spec = provider ? this.#specFor(provider, config) : { kind: 'none' };

    // 向量化：失败时降级为纯关键词（不阻断导入，保证小白用户仍可用）。
    let vectors = null;
    let embedError = '';
    let dim = 0;
    if (spec.kind !== 'none') {
      try {
        vectors = await embedTexts(spec, chunks.map((c) => c.text), {
          batchSize: config.embeddingBatchSize,
          onnxRuntime: this.onnx,
        });
        dim = vectors?.[0]?.length ?? 0;
      } catch (error) {
        embedError = String(error?.message ?? error);
        vectors = null;
      }
    }

    const lines = input.text.split('\n');
    const prepared = chunks.map((chunk, i) => ({
      index: i,
      text: chunk.text,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      lineStart: lineNumberAt(input.text, chunk.charStart),
      lineEnd: lineNumberAt(input.text, chunk.charEnd),
      pageNo: pageAt(pageMarks, chunk.charStart),
      embedding: vectors?.[i] ?? [],
    }));

    const { document, chunks: count, skipped } = this.store.addDocument({
      baseId,
      title: input.title,
      text: input.text,
      sourceType: input.sourceType,
      sourcePath: input.sourcePath,
      mimeType: input.mimeType,
      pageCount: input.pageCount,
      chunks: prepared,
      dim,
      status: embedError === '' ? 'ready' : 'partial',
      error: embedError,
    });

    if (dim > 0) this.store.setBaseIndexDim(baseId, dim);
    return {
      document,
      chunks: count,
      skipped,
      embedded: vectors !== null,
      dim,
      embedError,
      message: skipped
        ? '内容与已有文档完全相同，已跳过（未重复索引）。'
        : embedError !== ''
          ? `已导入 ${count} 个分块，但向量化失败（已降级为关键词检索）：${embedError}`
          : `已导入 ${count} 个分块，向量维度 ${dim}。`,
    };
  }

  /** 由 provider 记录构造 embedTexts 所需的 spec。 */
  #specFor(provider, config) {
    const apiKey = provider.apiKey || resolveApiKey(config);
    if (provider.kind === 'onnx') {
      return { kind: 'onnx', endpoint: '', model: provider.model || config.embeddingModel || DEFAULT_ONNX_MODEL, apiKey: '' };
    }
    if (provider.kind === 'ollama') {
      return {
        kind: 'ollama',
        endpoint: provider.endpoint || config.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT,
        model: provider.model || config.ollamaModel,
        apiKey: '',
      };
    }
    return {
      kind: provider.kind,
      endpoint: provider.endpoint || config.embeddingEndpoint || DEFAULT_OPENAI_ENDPOINT,
      model: provider.model || config.embeddingModel,
      apiKey,
    };
  }

  // ───────────────────────── 文档管理 ─────────────────────────

  listDocuments(baseId) {
    return this.store.listDocuments(baseId);
  }

  deleteDocument(id) {
    return this.store.deleteDocument(id);
  }

  // ───────────────────────── 重建索引 ─────────────────────────

  /**
   * 重建某个知识库的索引：按当前绑定模型重算全部向量。
   * @param {string} baseId
   * @param {{onProgress?:(p:{percent:number,done:number,total:number,stage:string})=>void}} options
   */
  async reindexBase(baseId, options = {}) {
    const base = this.store.getBase(baseId);
    if (!base) throw new EmbeddingError('知识库不存在', '请刷新页面后重试。');
    const config = resolveConfigForBase(this.config(), null);
    const provider = this.store.getActiveProvider(baseId);
    const spec = provider ? this.#specFor(provider, config) : { kind: 'none' };

    const documents = this.store.listDocuments(baseId);
    const report = { baseId, documents: documents.length, chunks: 0, embedded: 0, failed: [], dim: 0 };

    this.store.setBaseStatus(baseId, 'indexing');

    // 逐个文档重建：失败不中断整批，最后汇总。
    for (let i = 0; i < documents.length; i += 1) {
      const doc = documents[i];
      options.onProgress?.({
        percent: Math.round((i / Math.max(1, documents.length)) * 100),
        done: i,
        total: documents.length,
        stage: `正在重建：${doc.title}`,
      });
      try {
        const candidates = this.store.loadCandidates(baseId).filter((c) => c.documentId === doc.id);
        if (candidates.length === 0) continue;

        let vectors = null;
        if (spec.kind !== 'none') {
          vectors = await embedTexts(spec, candidates.map((c) => c.text), {
            batchSize: config.embeddingBatchSize,
            onnxRuntime: this.onnx,
          });
          report.dim = vectors?.[0]?.length ?? 0;
        }

        // 用新向量覆盖旧值：直接重建该文档的分块（文本与偏移不变）。
        this.#rewriteEmbeddings(baseId, doc, candidates, vectors);
        report.chunks += candidates.length;
        if (vectors !== null) report.embedded += candidates.length;
      } catch (error) {
        report.failed.push({ documentId: doc.id, title: doc.title, error: String(error?.message ?? error) });
      }
    }

    if (report.dim > 0) this.store.setBaseIndexDim(baseId, report.dim);
    this.store.setBaseStatus(baseId, report.failed.length > 0 ? 'partial' : 'ready');
    options.onProgress?.({ percent: 100, done: documents.length, total: documents.length, stage: '完成' });
    return report;
  }

  /** 覆盖式写回某文档分块的向量。 */
  #rewriteEmbeddings(baseId, doc, candidates, vectors) {
    const db = this.store.db;
    const update = db.prepare('UPDATE chunk SET embedding = ?, dim = ? WHERE id = ?');
    for (let i = 0; i < candidates.length; i += 1) {
      const vector = vectors?.[i] ?? [];
      update.run(vector.length > 0 ? JSON.stringify(vector) : '', vector.length, String(candidates[i].id));
    }
    db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(Date.now(), String(doc.id));
    this.store.setBaseStatus(baseId, 'ready');
  }

  // ───────────────────────── 检索 ─────────────────────────

  /**
   * 检索。支持限定知识库范围；未指定时检索全部。
   * @param {{query:string, baseId?:string|'all', topK?:number, mode?:string}} input
   */
  async search(input) {
    const query = String(input?.query ?? '').trim();
    if (query === '') throw new EmbeddingError('查询内容为空', '请输入要检索的问题。');

    const scope = String(input?.baseId ?? 'all');
    const bases = scope === 'all' || scope === ''
      ? this.store.listBases()
      : this.store.listBases().filter((b) => b.id === scope);
    if (bases.length === 0) {
      return { hits: [], elapsedMs: 0, baseCount: 0, message: '没有可检索的知识库，请先添加文档。' };
    }

    const started = Date.now();
    const globalConfig = this.config();
    const allHits = [];
    let mode = String(input?.mode ?? '') || globalConfig.searchMode;
    let reranked = false;
    let rerankError = '';

    for (const base of bases) {
      const config = resolveConfigForBase(globalConfig, null);
      const provider = this.store.getActiveProvider(base.id);
      const spec = provider ? this.#specFor(provider, config) : { kind: 'none' };

      let candidates = this.store.loadCandidates(base.id);
      if (candidates.length === 0) continue;

      // FTS 预筛：大语料下先缩小候选集；命中太少则退回全量（保证召回）。
      const ftsIds = this.store.searchFts(base.id, query, 400);
      if (ftsIds.length > 0 && ftsIds.length < candidates.length) {
        const keep = new Set(ftsIds);
        const narrowed = candidates.filter((c) => keep.has(c.id));
        // 只保留至少 10 条候选，否则词法召回可能过窄。
        if (narrowed.length >= 10) candidates = narrowed;
      }

      // 查询向量。
      let queryVector;
      if (spec.kind !== 'none') {
        try {
          const vectors = await embedTexts(spec, [query], { batchSize: 1, onnxRuntime: this.onnx });
          queryVector = vectors?.[0];
        } catch (error) {
          // 查询向量失败：该库降级为纯词法，不阻断其它库。
          queryVector = undefined;
          rerankError = rerankError || String(error?.message ?? error);
        }
      }

      const ranked = rank(query, candidates.map((c) => ({
        id: c.id,
        text: c.text,
        embedding: c.embedding,
      })), {
        mode,
        topK: Math.max(Number(input?.topK ?? 0) || config.topK, config.topK),
        threshold: config.similarityThreshold,
        mmr: config.mmrDiversity > 0,
        mmrLambda: 1 - config.mmrDiversity,
        rrfVectorWeight: config.rrfVectorWeight,
        queryVector,
      });

      const byId = new Map(candidates.map((c) => [c.id, c]));
      for (const hit of ranked) {
        const candidate = byId.get(hit.id);
        if (!candidate) continue;
        allHits.push({
          ...hit,
          ...candidate,
          baseName: base.name,
          score: hit.score,
          lexicalScore: hit.lexicalScore,
          vectorScore: hit.vectorScore,
        });
      }
    }

    allHits.sort((a, b) => b.score - a.score);

    // 可选重排序。
    const config = globalConfig;
    let finalHits = allHits;
    if (config.rerankEnabled && config.rerankEndpoint && allHits.length > 1) {
      try {
        finalHits = await this.#rerank(query, allHits, config);
        reranked = true;
      } catch (error) {
        rerankError = String(error?.message ?? error);
      }
    }

    const topK = Number(input?.topK ?? 0) || config.topK;
    const kept = dedupeAndTruncate(finalHits.slice(0, Math.max(topK * 3, topK)), {
      maxChars: 40000,
      maxPerDocument: Math.max(1, config.siblingChunks + 2),
    }).slice(0, topK);

    return {
      hits: kept.map((hit) => this.#formatHit(hit)),
      elapsedMs: Date.now() - started,
      baseCount: bases.length,
      reranked,
      rerankError,
      mode,
      totalCandidates: allHits.length,
    };
  }

  /** 远程重排序：POST {endpoint}，期望 OpenAI 风格 rerank 响应或 {results:[{index,relevance_score}]}。 */
  async #rerank(query, hits, config) {
    const endpoint = normalizeEndpoint(config.rerankEndpoint);
    const model = String(config.rerankModel ?? '').trim();
    const apiKey = resolveApiKey(config, 'rerank');
    const topN = Math.min(hits.length, config.rerankTopN);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        query,
        documents: hits.slice(0, topN).map((h) => h.text),
        top_n: topN,
      }),
    });
    if (!res.ok) {
      throw new EmbeddingError(`重排序端点返回 HTTP ${res.status}`, '请检查重排序端点与密钥；也可关闭重排序继续使用混合检索。');
    }
    const payload = await res.json();
    const results = Array.isArray(payload?.results) ? payload.results : null;
    if (results === null) {
      throw new EmbeddingError('重排序端点返回格式不符合预期', '期望 { results: [{ index, relevance_score }] } 结构。');
    }
    const scored = results
      .map((r) => ({ hit: hits[Number(r?.index) || 0], score: Number(r?.relevance_score ?? r?.score ?? 0) }))
      .filter((x) => x.hit);
    scored.sort((a, b) => b.score - a.score);
    const rest = hits.slice(topN);
    return [...scored.map((x) => ({ ...x.hit, score: x.score, rerankScore: x.score })), ...rest];
  }

  /** 把内部命中格式化成对外结构（含来源标注，供 UI 点击打开原文件）。 */
  #formatHit(hit) {
    const sourcePath = String(hit.sourcePath ?? '');
    const isFile = sourcePath !== '';
    let locator = '';
    if (hit.pageNo > 0) locator = `第 ${hit.pageNo} 页`;
    else if (hit.lineStart > 0) locator = `第 ${hit.lineStart} 行`;
    else locator = `第 ${hit.chunkIndex + 1} 段`;

    return {
      id: hit.id,
      documentId: hit.documentId,
      baseId: hit.baseId,
      baseName: hit.baseName ?? '',
      documentTitle: hit.documentTitle ?? '',
      score: Number(Number(hit.score ?? 0).toFixed(6)),
      lexicalScore: hit.lexicalScore === undefined ? null : Number(hit.lexicalScore.toFixed(6)),
      vectorScore: hit.vectorScore === undefined ? null : Number(hit.vectorScore.toFixed(6)),
      rerankScore: hit.rerankScore ?? null,
      text: hit.text,
      truncated: hit.truncated === true,
      chunkIndex: hit.chunkIndex,
      charStart: hit.charStart,
      charEnd: hit.charEnd,
      lineStart: hit.lineStart,
      lineEnd: hit.lineEnd,
      pageNo: hit.pageNo,
      source: {
        type: String(hit.sourceType ?? ''),
        path: sourcePath,
        title: hit.documentTitle ?? '',
        locator,
        // UI 用它拼「打开原文件」动作；文本型文档没有路径，只能定位到分块。
        openable: isFile,
      },
    };
  }

  /** 状态页数据：检测报告 + 下载进度 + 统计。 */
  async status() {
    const config = this.config();
    const report = this.detectReport ?? await this.detect();
    const stats = this.store.stats();
    return {
      detect: report,
      downloads: this.onnx.listStatus(),
      stats,
      config: {
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
        chunkSize: config.chunkSize,
        chunkOverlap: config.chunkOverlap,
        topK: config.topK,
        searchMode: config.searchMode,
        rerankEnabled: config.rerankEnabled,
        autoRetrieve: config.autoRetrieve,
      },
    };
  }

  /** 触发本地模型下载（后台进行，进度可轮询）。 */
  startModelDownload(modelId) {
    const id = String(modelId || DEFAULT_ONNX_MODEL);
    // 不 await：下载在后台进行，状态由 status() 轮询。
    void this.onnx.embed(id, ['预热'], { batchSize: 1 }).catch(() => {
      /* 错误已记录进 onnx.status，由状态页展示 */
    });
    return { started: true, model: id };
  }

  cancelModelDownload(modelId) {
    return this.onnx.cancel(modelId);
  }

  close() {
    this.onnx.unloadAll();
    this.store.close();
  }
}

function defaultProviderName(kind) {
  return {
    openai: 'OpenAI 兼容端点',
    custom: '自定义 HTTP 端点',
    onnx: '本地 ONNX（内置）',
    ollama: 'Ollama 本地',
    none: '纯关键词（未配置向量引擎）',
  }[kind] ?? '未命名 provider';
}

function defaultModelFor(kind) {
  return {
    openai: 'text-embedding-3-small',
    custom: '',
    onnx: DEFAULT_ONNX_MODEL,
    ollama: 'bge-m3',
    none: '',
  }[kind] ?? '';
}

export { explainHit, contentHash };
