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
import { findLocalModel, validateModelId, listDownloadable } from './local-models.js';
import { join } from 'node:path';

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
      // HF 镜像：配置 > 环境变量（onnx-runtime 内部再兜底默认镜像）。
      hfMirror: String(rawConfig.hfEndpoint ?? ''),
    });
    this.detectReport = null;
    // 自愈：清理历史版本「草稿测试」泄漏的临时 provider（__draft_xxx）。
    // 旧实现是「先创建临时 provider → 测试 → 删除」，中途失败就永久留下垃圾。
    // 新实现用 testProviderSpec 纯函数，草稿不再落库；此处只兜底清历史。
    try {
      const junk = this.store.listProviders().filter((p) => String(p.name ?? '').startsWith('__draft_'));
      for (const p of junk) this.store.deleteProvider(p.id);
      if (junk.length > 0) {
        // logger 此时尚未注入，静默即可；结果会在下次 listProviders 中体现。
      }
    } catch {
      /* 自愈失败不阻塞启动 */
    }
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
    const name = String(input?.name ?? '').trim();
    const endpoint = kind === 'onnx' ? '' : String(input?.endpoint ?? '');
    const model = String(input?.model ?? '') || defaultModelFor(kind);
    const inputTypeMode = String(input?.inputTypeMode ?? 'none') || 'none';
    // 防重复：同 kind+model+endpoint+inputTypeMode 已存在 → 直接复用（截图实证同一配置
    // 可以无限创建，「千问」出现了两次）。inputTypeMode 必须参与比较，否则「同一模型
    // 的对称/非对称两种用法」会被误判为同一个 provider 而错误复用。
    const existing = this.store.listProviders().find((p) => p.kind === kind
      && p.model === model
      && p.endpoint === endpoint
      && String(p.inputTypeMode ?? 'none') === inputTypeMode);
    if (existing) return { ...existing, reused: true };

    const provider = this.store.createProvider({
      kind,
      name: name || defaultProviderName(kind),
      endpoint,
      apiKey: String(input?.apiKey ?? ''),
      model,
      dim: Number(input?.dim ?? 0) || 0,
      inputTypeMode,
    });
    return provider;
  }

  updateProvider(id, patch) {
    const current = this.store.getProvider(id);
    if (!current) throw new EmbeddingError('provider 不存在', '请刷新页面后重试。');
    const kind = String(patch?.kind ?? current.kind);
    const updated = this.store.updateProvider(id, {
      kind,
      name: String(patch?.name ?? current.name),
      endpoint: kind === 'onnx' ? '' : String(patch?.endpoint ?? current.endpoint),
      apiKey: patch?.apiKey === undefined ? current.apiKey : String(patch.apiKey),
      model: String(patch?.model ?? current.model),
      dim: Number(patch?.dim ?? current.dim) || 0,
      inputTypeMode: String(patch?.inputTypeMode ?? current.inputTypeMode ?? 'none') || 'none',
      enabled: patch?.enabled === undefined ? current.enabled : patch.enabled !== false,
    });

    // 模型名（向量源）变了：所有绑定了该 provider 的知识库，其既有向量都由
    // 旧模型生成，必须重建。这是「改了模型却没人提醒」的真实事故路径。
    // 同理，切换「非对称模式」会改变向量空间（是否携带 input_type 决定编码方式），
    // 既有向量与新向量不再可比，也必须重建。
    const modelChanged = String(current.model ?? '') !== String(updated.model ?? '');
    const modeChanged = String(current.inputTypeMode ?? 'none') !== String(updated.inputTypeMode ?? 'none');
    if (modelChanged || modeChanged) {
      for (const base of this.store.listBasesBoundTo(id)) {
        this.store.setBaseStatus(base.id, 'stale');
      }
    }
    return updated;
  }

  deleteProvider(id) {
    return this.store.deleteProvider(id);
  }

  /**
   * 测试一份引擎规格（**不落库**）。
   * 草稿测试与已存 provider 测试共用此纯函数——草稿不再走「先建后删」，
   * 从根上杜绝 __draft_ 垃圾记录泄漏。
   * @param {{kind:string, endpoint:string, model:string, apiKey:string}} spec
   * @returns {Promise<{ok:boolean, latencyMs:number, dim?:number, error?:string, suggestion?:string}>}
   */
  async testProviderSpec(spec) {
    const config = this.config();
    const kind = String(spec?.kind ?? 'onnx');
    const model = String(spec?.model ?? '');
    const apiKey = spec?.apiKey || resolveApiKey(config);

    if (kind === 'onnx') {
      // 真实加载 + 一次探针推理拿维度——文件在 ≠ 模型可用，维度也只有在
      // 真实输出上才可信（此前只查缓存文件就回显旧值，dim 恒为 0，绑定表
      // 一直显示「模型维度未知」）。
      // 缓存文件缺失时不再提前失败：embed 内部会触发下载（经镜像），失败会
      // 带中文原因返回，用户可在状态页看进度后重测。
      try {
        const vectors = await this.onnx.embed(model || DEFAULT_ONNX_MODEL, ['维度探测'], { batchSize: 1 });
        const dim = Array.isArray(vectors?.[0]) ? vectors[0].length : 0;
        return dim > 0
          ? { ok: true, latencyMs: 0, dim }
          : { ok: false, latencyMs: 0, error: '模型输出为空向量', suggestion: '请删除模型缓存目录后重试；或改用 Ollama / 远程端点。' };
      } catch (error) {
        return {
          ok: false,
          latencyMs: 0,
          error: `模型加载/推理失败：${String(error?.message ?? error)}`,
          suggestion: String(error?.suggestion ?? '首次使用需下载模型权重（经 hf-mirror.com 镜像），可在「状态」页查看下载进度后重测；也可改用 Ollama / 远程端点。'),
        };
      }
    }

    if (kind === 'ollama') {
      const probe = await probeOllama(spec.endpoint || config.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT);
      if (!probe.ok) {
        return { ok: false, latencyMs: probe.latencyMs, error: probe.error, suggestion: probe.suggestion };
      }
      // Ollama 在线，再验证目标模型是否已 pull。
      const has = (probe.models ?? []).some((m) => m === model || m.startsWith(`${model}:`));
      if (!has) {
        return {
          ok: false,
          latencyMs: probe.latencyMs,
          error: `Ollama 在线，但未找到模型「${model}」`,
          suggestion: `请执行：ollama pull ${model}`,
        };
      }
      // 模型在列 ≠ embedding 可用：真实发一次探测拿维度（此前只回显旧值，
      // dim 恒为 0，绑定表显示「维度未知」）。
      try {
        const vectors = await embedTexts({ ...spec, apiKey }, ['维度探测'], { batchSize: 1 });
        const dim = Array.isArray(vectors?.[0]) ? vectors[0].length : 0;
        return dim > 0
          ? { ok: true, latencyMs: probe.latencyMs, dim }
          : { ok: false, latencyMs: probe.latencyMs, error: '模型返回空向量', suggestion: `请确认「${model}」是 embedding 模型。` };
      } catch (error) {
        return {
          ok: false,
          latencyMs: probe.latencyMs,
          error: `模型推理失败：${String(error?.message ?? error)}`,
          suggestion: String(error?.suggestion ?? `请确认「${model}」支持 embeddings 接口。`),
        };
      }
    }

    if (kind === 'none') {
      return { ok: true, latencyMs: 0, dim: 0 };
    }

    // 测试连接：非对称模型必须带 input_type 才通（否则 NIM 返回 400）。
    return probeRemote({
      kind,
      endpoint: spec?.endpoint,
      model,
      apiKey,
      inputType: spec?.inputTypeMode === 'asymmetric' ? 'passage' : '',
    });
  }

  /**
   * 测试已保存的 provider：读记录 → testProviderSpec → 结果落库（状态灯 + 延迟 + 维度）。
   * @returns {Promise<{ok:boolean, latencyMs:number, dim?:number, error?:string, suggestion?:string}>}
   */
  async testProvider(id) {
    const provider = this.store.getProvider(id);
    if (!provider) throw new EmbeddingError('provider 不存在', '请刷新页面后重试。');
    const config = this.config();
    const result = await this.testProviderSpec({
      kind: provider.kind,
      endpoint: provider.endpoint,
      model: provider.model,
      apiKey: provider.apiKey || resolveApiKey(config),
      inputTypeMode: provider.inputTypeMode,
    });

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

  /** 把知识库绑定到某 provider；维度已知且不一致时标记需重建。 */
  bindProvider(baseId, providerId, role = 'embedding') {
    const base = this.store.getBase(baseId);
    if (!base) throw new EmbeddingError('知识库不存在', '请刷新页面后重试。');
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new EmbeddingError('provider 不存在', '请刷新页面后重试。');

    // 换绑前的旧 provider（用于判断「是否真的换了一个不同的向量源」）。
    const previous = this.store.getActiveProvider(baseId, role);

    this.store.bindProvider(baseId, providerId, role);
    const check = checkDimension(provider.dim, base.indexDim);

    // 三种情况都应触发「需重建」：
    //   1. 维度已知且不一致（最直接的证据）；
    //   2. 换成了一个 dim 未知（从未测试）的 provider——旧向量由旧模型生成，
    //      新模型维度未知，唯一安全的姿态就是要求重建后再用；
    //   3. 同一 provider 的模型名被改过（视为换了向量源）。
    const changedSource = previous !== null && previous.id !== provider.id;
    const modelRenamed = previous !== null && previous.id === provider.id
      && String(previous.model ?? '') !== String(provider.model ?? '');
    const dimensionKnown = provider.dim > 0;
    const needsReindex = (dimensionKnown && check.status === 'mismatch')
      || (changedSource && !dimensionKnown)
      || modelRenamed;
    if (needsReindex) this.store.setBaseStatus(baseId, 'stale');
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
        '当前支持 PDF、DOCX、PPTX、MD、TXT、HTML 等文本格式；旧版 .doc/.ppt/.xls 请先另存为新格式。',
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
   * 导入一个目录（递归全部层级，无深度限制；跳过噪声目录与不支持的类型）。
   * @returns {Promise<{imported:number, skipped:number, duplicate:number,
   *   failed:Array<{path:string,error:string}>,
   *   skippedByExt:Record<string,number>, folders:number, root:string}>}
   */
  async addDirectory(input) {
    const { readdir } = await import('node:fs/promises');
    const { extname } = await import('node:path');
    const dir = String(input?.dirPath ?? '').replace(/[\\/]+$/, '');
    const baseId = String(input?.baseId ?? '');
    const result = {
      imported: 0, skipped: 0, duplicate: 0, failed: [],
      skippedByExt: {}, folders: 0, root: dir,
    };

    const walk = async (current) => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        result.failed.push({ path: current, error: `无法读取目录：${String(error?.message ?? error)}` });
        return;
      }
      result.folders += 1;
      for (const entry of entries) {
        const full = `${current}\\${entry.name}`;
        if (entry.isDirectory()) {
          // 跳过常见噪声目录（递归无深度限制，但这类目录没有索引价值）。
          if (/^(node_modules|\.git|\.cache|dist|build|__pycache__|\.venv|venv|\$RECYCLE\.BIN|System Volume Information)$/i.test(entry.name)) continue;
          await walk(full);
          continue;
        }
        if (!isSupported(full)) {
          result.skipped += 1;
          const ext = (extname(entry.name) || '（无扩展名）').toLowerCase();
          result.skippedByExt[ext] = (result.skippedByExt[ext] ?? 0) + 1;
          continue;
        }
        try {
          const r = await this.addFile({ baseId, filePath: full });
          if (r.skipped) result.duplicate += 1;
          else result.imported += 1;
        } catch (error) {
          result.failed.push({ path: full, error: String(error?.message ?? error) });
        }
      }
    };

    await walk(dir);
    return result;
  }

  /** 某库的有效配置 = 全局配置 + 该库自己的覆盖（provider 绑定之外的检索/分块参数）。 */
  #configForBase(baseId) {
    return resolveConfigForBase(this.config(), this.store.getBaseOverrides(baseId));
  }

  /** 导入核心：解析结果 → 分块 → 向量化 → 落库。 */
  async #ingest(input) {
    const baseId = String(input.baseId ?? '');
    const base = this.store.getBase(baseId);
    if (!base) throw new EmbeddingError('知识库不存在', '请先在「知识库列表」中创建或选择一个知识库。');

    const config = this.#configForBase(baseId);
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
    // 导入文档 → 建索引，非对称模型用 passage。
    const spec = provider ? this.#specFor(provider, config, 'passage') : { kind: 'none' };

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

    // 维度一致性守卫：库里已有向量、且本次成功拿到了向量时，
    // 新维度必须与既有维度一致，否则会产生「同一库内 4 维与 8 维混存」的
    // 检索数据（余弦相似度跨维度无意义，等于静默产出坏索引）。
    // 场景：换绑模型后没有重建就继续导入。此时拒绝写入，指引先重建。
    const existingDim = Number(base.indexDim ?? 0);
    if (existingDim > 0 && dim > 0 && dim !== existingDim) {
      throw new EmbeddingError(
        `新文档维度（${dim}）与已建索引维度（${existingDim}）不一致`,
        '该知识库更换过向量模型但尚未重建索引。请先在「知识库列表」中执行「重建索引」，再导入新文档。',
      );
    }

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

  /**
   * 由 provider 记录构造 embedTexts 所需的 spec。
   * @param {object} provider provider 记录
   * @param {object} config 该库的有效配置
   * @param {'passage'|'query'} role 本次用途：建索引/重建用 passage，检索查询用 query。
   *   provider.inputTypeMode 为 'asymmetric' 时才附加 input_type，否则保持旧行为（不发该字段）。
   */
  #specFor(provider, config, role = 'passage') {
    const apiKey = provider.apiKey || resolveApiKey(config);
    // 非对称模型开关：只有显式开启才发 input_type，避免影响既有 provider。
    const inputType = provider.inputTypeMode === 'asymmetric' ? role : '';
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
      inputType,
    };
  }

  // ───────────────────────── 文档管理 ─────────────────────────

  listDocuments(baseId) {
    return this.store.listDocuments(baseId);
  }

  /** 「知识库 → 文件夹」聚合视图。 */
  listSourceFolders(baseId) {
    return this.store.listSourceFolders(baseId);
  }

  /**
   * 删除某来源文件夹的全部索引（只删库内索引数据，磁盘原文件不动）。
   */
  deleteSourceFolder(baseId, folder) {
    return this.store.deleteSourceFolder(baseId, folder);
  }

  deleteDocument(id) {
    return this.store.deleteDocument(id);
  }

  // ───────────────────────── 重建索引 ─────────────────────────

  /**
   * 重建进度快照（内存态，供 HTTP 轮询）。
   * {running, baseId, percent, done, total, stage, startedAt, finishedAt, result}
   */
  reindexProgress = null;

  /** 查询重建进度（UI 轮询用）。 */
  getReindexProgress() {
    return this.reindexProgress ?? { running: false };
  }

  /**
   * 重建某个知识库的索引：按当前绑定模型重算全部向量。
   * @param {string} baseId
   * @param {{onProgress?:(p:{percent:number,done:number,total:number,stage:string})=>void}} options
   */
  async reindexBase(baseId, options = {}) {
    const base = this.store.getBase(baseId);
    if (!base) throw new EmbeddingError('知识库不存在', '请刷新页面后重试。');
    const config = this.#configForBase(baseId);
    const provider = this.store.getActiveProvider(baseId);
    // 重建索引 = 重新编码文档，非对称模型用 passage。
    const spec = provider ? this.#specFor(provider, config, 'passage') : { kind: 'none' };

    const documents = this.store.listDocuments(baseId);
    const report = { baseId, documents: documents.length, chunks: 0, embedded: 0, failed: [], dim: 0 };

    this.reindexProgress = {
      running: true, baseId, percent: 0, done: 0, total: documents.length,
      stage: '开始重建', startedAt: Date.now(), finishedAt: null, result: null,
    };
    const track = (p) => {
      // onProgress 回调与内存快照同步更新，二者消费方不同（调用方 / HTTP 轮询）。
      this.reindexProgress = { ...this.reindexProgress, ...p, running: true };
      options.onProgress?.(p);
    };

    this.store.setBaseStatus(baseId, 'indexing');
    track({ percent: 0, done: 0, total: documents.length, stage: '开始重建' });

    // 一次性加载全部候选，按文档分组——避免每个文档都全库扫描（O(N×M) → O(M)）。
    const allCandidates = this.store.loadCandidates(baseId);
    const byDocument = new Map();
    for (const c of allCandidates) {
      if (!byDocument.has(c.documentId)) byDocument.set(c.documentId, []);
      byDocument.get(c.documentId).push(c);
    }

    // 逐个文档重建：失败不中断整批，最后汇总。
    for (let i = 0; i < documents.length; i += 1) {
      const doc = documents[i];
      track({
        percent: Math.round((i / Math.max(1, documents.length)) * 100),
        done: i,
        total: documents.length,
        stage: `正在重建：${doc.title}`,
      });
      try {
        const candidates = byDocument.get(doc.id) ?? [];
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
        this.#rewriteEmbeddings(doc, candidates, vectors);
        report.chunks += candidates.length;
        if (vectors !== null) report.embedded += candidates.length;
      } catch (error) {
        report.failed.push({ documentId: doc.id, title: doc.title, error: String(error?.message ?? error) });
      }
    }

    if (report.dim > 0) this.store.setBaseIndexDim(baseId, report.dim);
    // 状态只在全部文档处理完后写一次，中途不回写（保持 indexing 可见）。
    this.store.setBaseStatus(baseId, report.failed.length > 0 ? 'partial' : 'ready');
    track({ percent: 100, done: documents.length, total: documents.length, stage: '完成' });
    this.reindexProgress = {
      ...this.reindexProgress,
      running: false, percent: 100, stage: '完成',
      finishedAt: Date.now(), result: report,
    };
    return report;
  }

  /** 覆盖式写回某文档分块的向量（单事务）。 */
  #rewriteEmbeddings(doc, candidates, vectors) {
    const db = this.store.db;
    this.store.transaction(() => {
      const update = db.prepare('UPDATE chunk SET embedding = ?, dim = ? WHERE id = ?');
      for (let i = 0; i < candidates.length; i += 1) {
        const vector = vectors?.[i] ?? [];
        update.run(vector.length > 0 ? JSON.stringify(vector) : '', vector.length, String(candidates[i].id));
      }
      db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(Date.now(), String(doc.id));
    });
  }

  // ───────────────────────── 检索 ─────────────────────────

  /**
   * 检索。支持限定知识库范围；未指定时检索全部。
   * @param {{query:string, baseId?:string|'all', topK?:number, mode?:string, signal?:AbortSignal}} input
   */
  async search(input) {
    const query = String(input?.query ?? '').trim();
    if (query === '') throw new EmbeddingError('查询内容为空', '请输入要检索的问题。');
    const signal = input?.signal;
    // 宿主中止会话时立即退出，不做无谓的检索工作。
    if (signal?.aborted) throw new EmbeddingError('检索已取消', '');
    const onAbort = () => { throw new EmbeddingError('检索已取消', ''); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.#searchInner(input, query, signal);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** 检索主流程（由 search 包裹，提供取消语义）。 */
  async #searchInner(input, query, signal) {
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
      const config = this.#configForBase(base.id);
      const provider = this.store.getActiveProvider(base.id);
      // 检索查询 → 非对称模型必须用 query，才能与索引期的 passage 对齐。
      const spec = provider ? this.#specFor(provider, config, 'query') : { kind: 'none' };

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
          const vectors = await embedTexts(spec, [query], { batchSize: 1, onnxRuntime: this.onnx, signal });
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
    // 硬超时：重排序是锦上添花，端点挂起绝不能拖死整个检索。
    const timeoutMs = 8000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(endpoint, {
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
        signal: controller.signal,
      });
    } catch (error) {
      throw new EmbeddingError(
        `重排序请求失败：${String(error?.name === 'AbortError' ? `超过 ${timeoutMs / 1000} 秒超时` : String(error?.message ?? error))}`,
        '请检查重排序端点是否可达；也可关闭重排序继续使用混合检索。',
      );
    } finally {
      clearTimeout(timer);
    }
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
    // 下载引导：运行时不可用时不应让用户点「下载」再吃一次失败，
    // 直接告知安装方式（依赖随 optionalDependencies 分发；此处兜底提示手动安装）。
    const onnxAvailable = report?.onnx?.ok === true;
    const downloads = this.onnx.listStatus().map((d) => ({
      ...d,
      runtimeUnavailable: !onnxAvailable,
    }));
    return {
      detect: report,
      downloads,
      onnxAvailable,
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
    // 运行时不可用时直接拒绝并给出安装指引，而不是让用户看 0% 进度条后报错。
    const onnxOk = (this.detectReport ?? { onnx: { ok: false } }).onnx?.ok === true;
    if (!onnxOk) {
      return {
        started: false,
        model: id,
        runtimeUnavailable: true,
        error: '本地 ONNX 运行时不可用（缺少 @huggingface/transformers 或 onnxruntime-node）',
        suggestion: '正常情况下这些依赖会随插件自动安装（optionalDependencies）。若被跳过，可在插件目录执行：npm i @huggingface/transformers@4.3.1 onnxruntime-node@1.30.0；或改用 Ollama / 远程端点 / 纯关键词检索。',
      };
    }
    // 只放行目录内的模型（或形状合法的自定义 id），防止把任意字符串塞进 pipeline。
    const known = findLocalModel(id) ?? validateModelId(id);
    if (!known) {
      return {
        started: false,
        model: id,
        error: '模型 id 不合法',
        suggestion: '请从「状态」页的模型清单中选择，或填写形如 owner/model 的 HuggingFace 模型 id。',
      };
    }
    // 不 await：下载在后台进行，状态由 status() 轮询。
    void this.onnx.embed(id, ['预热'], { batchSize: 1 }).catch(() => {
      /* 错误已记录进 onnx.status，由状态页展示 */
    });
    return { started: true, model: id };
  }

  /** 可下载模型清单（含描述与预计体积）。 */
  listLocalModels() {
    return listDownloadable();
  }

  cancelModelDownload(modelId) {
    return this.onnx.cancel(modelId);
  }

  /**
   * 删除某本地模型的缓存目录（失败模型占盘 / 需要重新下载时的自助清理）。
   * 只允许删插件自己的模型缓存根目录之下的内容，防路径逃逸。
   */
  async deleteModelCache(modelId) {
    const { rm } = await import('node:fs/promises');
    const root = resolveModelCacheDir(this.rawConfig.localModelCacheDir);
    const id = String(modelId ?? '').trim();
    // repo id 形状校验（owner/model），目录拼出来必然位于缓存根之下。
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(id)) {
      throw new EmbeddingError('模型 id 不合法', '请从「状态」页的模型清单中选择。');
    }
    // 卸载已加载实例，避免删除时文件被占用。
    this.onnx.unloadAll();
    const target = join(root, id);
    const resolvedRoot = join(root);
    if (!join(target).startsWith(resolvedRoot)) {
      throw new EmbeddingError('路径校验失败', '目标目录必须位于模型缓存根目录之下。');
    }
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      throw new EmbeddingError(
        `删除模型缓存失败：${String(error?.message ?? error)}`,
        '模型可能正在被使用（DSH 刚做过推理）。稍等几秒后重试，或重启 DSH 后再删。',
      );
    }
    // 清掉对应的状态记录。
    this.onnx.clearStatus(id);
    return { deleted: true, model: id };
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
