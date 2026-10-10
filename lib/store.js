/**
 * 存储层：SQLite（node:sqlite 内置）单文件，含 provider 注册表、知识库、
 * 文档、分块 + FTS5 全文索引，以及「知识库 ↔ provider」的多对多绑定。
 *
 * 表设计要点：
 *  - providers 是独立实体（不再把端点内联进每个知识库），一个 provider 可被多库复用；
 *  - base_providers 是绑定关系表，实现多对多；is_active 标记该库当前生效的绑定；
 *  - chunk 存向量（Float32 的 JSON 数组），配合 FTS5 做混合检索；
 *  - index_meta 记录已建索引的维度，用于维度校验与「需重建」判定。
 *
 * 全部 SQL 都用参数绑定，避免注入；中文内容按 UTF-8 原样存取。
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { tokenize } from './retrieval.js';

/** 生成短 id（时间戳 + 随机），足够本地唯一且可读。 */
export function makeId(prefix) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}

/** 内容哈希，用于跳过重复导入。 */
export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32);
}

/** 默认存储路径：<DSH_HOME>/storages/destinywind-rag.sqlite */
export function defaultStorePath() {
  const home = process.env.DSH_HOME ?? join(os.homedir(), '.dsh');
  return join(home, 'storages', 'destinywind-rag.sqlite');
}

export class KnowledgeStore {
  /**
   * @param {string} filePath SQLite 文件路径（空则用默认位置）
   */
  constructor(filePath) {
    this.filePath = filePath && String(filePath).trim() !== '' ? String(filePath) : defaultStorePath();
    if (this.filePath !== ':memory:') {
      mkdirSync(dirname(this.filePath), { recursive: true });
    }
    this.db = new DatabaseSync(this.filePath);
    this.#migrate();
  }

  /** 建表 + 兼容旧结构。全部 IF NOT EXISTS，可重复执行。 */
  #migrate() {
    const db = this.db;
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        endpoint TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        dim INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'unknown',
        latency_ms INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        suggestion TEXT NOT NULL DEFAULT '',
        checked_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS bases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ready',
        index_dim INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);

    // 知识库 ↔ provider 多对多绑定；is_active=1 表示该库当前生效的绑定。
    db.exec(`
      CREATE TABLE IF NOT EXISTS base_providers (
        base_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'embedding',
        is_active INTEGER NOT NULL DEFAULT 0,
        bound_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (base_id, provider_id, role)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        base_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'file',
        source_path TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT '',
        page_count INTEGER NOT NULL DEFAULT 0,
        char_count INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ready',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_documents_base ON documents(base_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS chunk (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        base_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        char_start INTEGER NOT NULL DEFAULT 0,
        char_end INTEGER NOT NULL DEFAULT 0,
        line_start INTEGER NOT NULL DEFAULT 0,
        line_end INTEGER NOT NULL DEFAULT 0,
        page_no INTEGER NOT NULL DEFAULT 0,
        embedding TEXT NOT NULL DEFAULT '',
        dim INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunk(document_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_chunk_base ON chunk(base_id)');

    // FTS5 全文索引。
    //
    // 关键：SQLite 自带的 unicode61 分词器不切分中文——「部署环境要求」会被
    // 当成一个完整 token，搜「部署」永远命中不了。这里改为在写入时把文本用
    // 与检索层同一套 tokenize() 预处理成「拉丁词 + CJK bigram」再存进 FTS，
    // 于是 FTS 的 token 粒度与应用层 BM25 完全一致，中文检索才能真正生效。
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
        chunk_id UNINDEXED,
        base_id UNINDEXED,
        body,
        tokenize = 'unicode61'
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  // ───────────────────────── provider CRUD ─────────────────────────

  listProviders() {
    return this.db.prepare('SELECT * FROM providers ORDER BY created_at ASC').all().map(rowToProvider);
  }

  getProvider(id) {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(String(id));
    return row ? rowToProvider(row) : null;
  }

  createProvider(input) {
    const now = Date.now();
    const id = String(input?.id ?? '') || makeId('pv');
    this.db.prepare(`
      INSERT INTO providers (id, kind, name, endpoint, api_key, model, dim, enabled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(input?.kind ?? 'onnx'),
      String(input?.name ?? '未命名 provider'),
      String(input?.endpoint ?? ''),
      String(input?.apiKey ?? ''),
      String(input?.model ?? ''),
      Number(input?.dim ?? 0) || 0,
      input?.enabled === false ? 0 : 1,
      String(input?.status ?? 'unknown'),
      now,
      now,
    );
    return this.getProvider(id);
  }

  updateProvider(id, patch) {
    const current = this.getProvider(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db.prepare(`
      UPDATE providers SET kind = ?, name = ?, endpoint = ?, api_key = ?, model = ?, dim = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      String(next.kind ?? current.kind),
      String(next.name ?? current.name),
      String(next.endpoint ?? current.endpoint),
      String(next.apiKey ?? current.apiKey),
      String(next.model ?? current.model),
      Number(next.dim ?? current.dim) || 0,
      next.enabled === false ? 0 : 1,
      Date.now(),
      String(id),
    );
    return this.getProvider(id);
  }

  /** 记录一次连接测试结果（状态灯与延迟就地展示）。 */
  recordProviderStatus(id, result) {
    this.db.prepare(`
      UPDATE providers SET status = ?, latency_ms = ?, error = ?, suggestion = ?, checked_at = ?
      WHERE id = ?
    `).run(
      result?.ok ? 'ok' : 'error',
      Number(result?.latencyMs ?? 0) || 0,
      String(result?.error ?? ''),
      String(result?.suggestion ?? ''),
      Date.now(),
      String(id),
    );
    return this.getProvider(id);
  }

  deleteProvider(id) {
    const used = this.listBasesBoundTo(id);
    this.db.prepare('DELETE FROM base_providers WHERE provider_id = ?').run(String(id));
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(String(id));
    // 绑定的库因失去 provider 而需要重建索引。
    for (const base of used) this.setBaseStatus(base.id, 'stale');
    return { deleted: true, affectedBases: used.map((b) => b.id) };
  }

  listBasesBoundTo(providerId) {
    return this.db.prepare(`
      SELECT b.* FROM bases b
      JOIN base_providers bp ON bp.base_id = b.id
      WHERE bp.provider_id = ?
    `).all(String(providerId)).map(rowToBase);
  }

  // ───────────────────────── 绑定（多对多） ─────────────────────────

  bindProvider(baseId, providerId, role = 'embedding') {
    this.db.prepare(`
      INSERT INTO base_providers (base_id, provider_id, role, is_active, bound_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(base_id, provider_id, role) DO UPDATE SET is_active = 1, bound_at = excluded.bound_at
    `).run(String(baseId), String(providerId), String(role), Date.now());
    // 同一 role 只允许一个 active 绑定。
    this.db.prepare(`
      UPDATE base_providers SET is_active = 0
      WHERE base_id = ? AND role = ? AND provider_id != ?
    `).run(String(baseId), String(role), String(providerId));
    this.db.prepare('UPDATE bases SET updated_at = ? WHERE id = ?').run(Date.now(), String(baseId));
  }

  unbindProvider(baseId, providerId, role = 'embedding') {
    this.db.prepare('DELETE FROM base_providers WHERE base_id = ? AND provider_id = ? AND role = ?')
      .run(String(baseId), String(providerId), String(role));
  }

  /** 取某库当前生效的 provider（按 role）。 */
  getActiveProvider(baseId, role = 'embedding') {
    const row = this.db.prepare(`
      SELECT p.* FROM providers p
      JOIN base_providers bp ON bp.provider_id = p.id
      WHERE bp.base_id = ? AND bp.role = ? AND bp.is_active = 1
      LIMIT 1
    `).get(String(baseId), String(role));
    return row ? rowToProvider(row) : null;
  }

  /** 绑定关系表：知识库 ↔ provider（供设置页「向量模型」下半部分展示）。 */
  listBindings() {
    const rows = this.db.prepare(`
      SELECT bp.base_id, bp.provider_id, bp.role, bp.is_active,
             b.name AS base_name, b.index_dim AS base_index_dim, b.status AS base_status,
             p.name AS provider_name, p.model AS provider_model, p.dim AS provider_dim, p.kind AS provider_kind
      FROM base_providers bp
      LEFT JOIN bases b ON b.id = bp.base_id
      LEFT JOIN providers p ON p.id = bp.provider_id
      ORDER BY b.name ASC
    `).all();
    return rows.map((r) => ({
      baseId: String(r.base_id),
      baseName: String(r.base_name ?? ''),
      baseStatus: String(r.base_status ?? 'ready'),
      providerId: String(r.provider_id),
      providerName: String(r.provider_name ?? ''),
      providerKind: String(r.provider_kind ?? ''),
      model: String(r.provider_model ?? ''),
      providerDim: Number(r.provider_dim) || 0,
      indexDim: Number(r.base_index_dim) || 0,
      role: String(r.role),
      active: Number(r.is_active) === 1,
    }));
  }

  // ───────────────────────── 知识库 CRUD ─────────────────────────

  listBases() {
    return this.db.prepare(`
      SELECT b.*, (SELECT COUNT(*) FROM documents d WHERE d.base_id = b.id) AS doc_count
      FROM bases b ORDER BY b.created_at ASC
    `).all().map((r) => ({ ...rowToBase(r), docCount: Number(r.doc_count) || 0 }));
  }

  getBase(id) {
    const r = this.db.prepare(`
      SELECT b.*, (SELECT COUNT(*) FROM documents d WHERE d.base_id = b.id) AS doc_count
      FROM bases b WHERE b.id = ?
    `).get(String(id));
    return r ? { ...rowToBase(r), docCount: Number(r.doc_count) || 0 } : null;
  }

  createBase(input) {
    const now = Date.now();
    const id = String(input?.id ?? '') || makeId('kb');
    this.db.prepare(`
      INSERT INTO bases (id, name, description, status, index_dim, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(input?.name ?? '未命名知识库'),
      String(input?.description ?? ''),
      String(input?.status ?? 'ready'),
      Number(input?.indexDim ?? 0) || 0,
      now,
      now,
    );
    if (input?.providerId) this.bindProvider(id, String(input.providerId), 'embedding');
    return this.getBase(id);
  }

  renameBase(id, name) {
    this.db.prepare('UPDATE bases SET name = ?, updated_at = ? WHERE id = ?')
      .run(String(name), Date.now(), String(id));
    return this.getBase(id);
  }

  setBaseStatus(id, status) {
    this.db.prepare('UPDATE bases SET status = ?, updated_at = ? WHERE id = ?')
      .run(String(status), Date.now(), String(id));
  }

  setBaseIndexDim(id, dim) {
    this.db.prepare('UPDATE bases SET index_dim = ?, updated_at = ? WHERE id = ?')
      .run(Number(dim) || 0, Date.now(), String(id));
  }

  /** 删除知识库及其全部文档、分块、FTS 条目与绑定。 */
  deleteBase(id) {
    const baseId = String(id);
    const chunks = this.db.prepare('SELECT id FROM chunk WHERE base_id = ?').all(baseId);
    for (const c of chunks) {
      this.db.prepare('DELETE FROM chunk_fts WHERE chunk_id = ?').run(String(c.id));
    }
    this.db.prepare('DELETE FROM chunk WHERE base_id = ?').run(baseId);
    this.db.prepare('DELETE FROM documents WHERE base_id = ?').run(baseId);
    this.db.prepare('DELETE FROM base_providers WHERE base_id = ?').run(baseId);
    this.db.prepare('DELETE FROM bases WHERE id = ?').run(baseId);
    return { deleted: true };
  }

  // ───────────────────────── 文档与分块 ─────────────────────────

  findDocumentByHash(baseId, hash) {
    const row = this.db.prepare('SELECT * FROM documents WHERE base_id = ? AND content_hash = ? LIMIT 1')
      .get(String(baseId), String(hash));
    return row ? rowToDocument(row) : null;
  }

  listDocuments(baseId) {
    return this.db.prepare('SELECT * FROM documents WHERE base_id = ? ORDER BY created_at ASC')
      .all(String(baseId)).map(rowToDocument);
  }

  getDocument(id) {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(String(id));
    return row ? rowToDocument(row) : null;
  }

  /**
   * 写入一个文档及其分块（覆盖式：同 content_hash 视为重复，默认跳过）。
   * @returns {{document:object, chunks:number, skipped:boolean}}
   */
  addDocument(input) {
    const baseId = String(input?.baseId ?? '');
    const text = String(input?.text ?? '');
    const hash = contentHash(text);
    if (input?.skipDuplicates !== false) {
      const existing = this.findDocumentByHash(baseId, hash);
      if (existing) return { document: existing, chunks: existing.chunkCount, skipped: true };
    }

    const now = Date.now();
    const docId = String(input?.id ?? '') || makeId('doc');
    const chunks = Array.isArray(input?.chunks) ? input.chunks : [];

    this.db.prepare(`
      INSERT INTO documents (id, base_id, title, source_type, source_path, mime_type, page_count,
        char_count, chunk_count, content_hash, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      docId, baseId,
      String(input?.title ?? '未命名文档'),
      String(input?.sourceType ?? 'file'),
      String(input?.sourcePath ?? ''),
      String(input?.mimeType ?? ''),
      Number(input?.pageCount ?? 0) || 0,
      text.length,
      chunks.length,
      hash,
      String(input?.status ?? 'ready'),
      String(input?.error ?? ''),
      now, now,
    );

    const insertChunk = this.db.prepare(`
      INSERT INTO chunk (id, document_id, base_id, chunk_index, text, char_start, char_end, line_start, line_end, page_no, embedding, dim)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare('INSERT INTO chunk_fts (chunk_id, base_id, body) VALUES (?, ?, ?)');

    for (const chunk of chunks) {
      const chunkId = String(chunk?.id ?? '') || makeId('ck');
      const embedding = Array.isArray(chunk?.embedding) ? chunk.embedding : [];
      insertChunk.run(
        chunkId, docId, baseId,
        Number(chunk?.index ?? 0) || 0,
        String(chunk?.text ?? ''),
        Number(chunk?.charStart ?? 0) || 0,
        Number(chunk?.charEnd ?? 0) || 0,
        Number(chunk?.lineStart ?? 0) || 0,
        Number(chunk?.lineEnd ?? 0) || 0,
        Number(chunk?.pageNo ?? 0) || 0,
        embedding.length > 0 ? JSON.stringify(embedding) : '',
        embedding.length,
      );
      // 存 tokenize() 预处理后的 token 流（空格分隔），让 FTS 的 token 粒度
      // 与应用层 BM25 一致，中文 bigram 才能被 MATCH 命中。
      insertFts.run(chunkId, baseId, tokenize(String(chunk?.text ?? '')).join(' '));
    }

    this.setBaseIndexDim(baseId, Number(input?.dim ?? 0) || 0);
    return { document: this.getDocument(docId), chunks: chunks.length, skipped: false };
  }

  deleteDocument(id) {
    const docId = String(id);
    const doc = this.getDocument(docId);
    if (!doc) return { deleted: false };
    const chunks = this.db.prepare('SELECT id FROM chunk WHERE document_id = ?').all(docId);
    for (const c of chunks) {
      this.db.prepare('DELETE FROM chunk_fts WHERE chunk_id = ?').run(String(c.id));
    }
    this.db.prepare('DELETE FROM chunk WHERE document_id = ?').run(docId);
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
    return { deleted: true };
  }

  /** 读取某库的全部候选分块（含向量），供检索排序使用。 */
  loadCandidates(baseId) {
    const rows = this.db.prepare(`
      SELECT c.*, d.title AS doc_title, d.source_path AS doc_path, d.source_type AS doc_source_type
      FROM chunk c LEFT JOIN documents d ON d.id = c.document_id
      WHERE c.base_id = ?
    `).all(String(baseId));
    return rows.map(rowToCandidate);
  }

  /**
   * FTS5 关键词预筛：返回命中的 chunk_id 集合（用于大语料下的候选缩减）。
   * 查询侧同样先 tokenize，再用 OR 连接各 token——OR 而非 AND，
   * 因为这是「候选预筛」，宁可多召回一些，精确排序交给应用层 BM25/向量。
   */
  searchFts(baseId, query, limit = 200) {
    const tokens = tokenize(String(query ?? ''));
    if (tokens.length === 0) return [];
    // FTS5 的 MATCH 语法里，双引号包裹表示短语，转义内部引号避免语法错误。
    // 每个 token 单独加引号并用 OR 连接，既避免保留字符破坏语法，又保证召回。
    const expr = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    try {
      return this.db.prepare(`
        SELECT chunk_id FROM chunk_fts
        WHERE chunk_fts MATCH ? AND base_id = ?
        LIMIT ?
      `).all(expr, String(baseId), Math.trunc(limit)).map((r) => String(r.chunk_id));
    } catch {
      // 查询里含 FTS 保留字符时会语法报错，此时退回全量候选（由应用层 BM25 兜底）。
      return [];
    }
  }

  /** 重建 FTS 索引（维度/模型变更后调用）。 */
  rebuildFts() {
    this.db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')");
    return { rebuilt: true };
  }

  countChunks(baseId) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chunk WHERE base_id = ?').get(String(baseId));
    return Number(row?.n) || 0;
  }

  // ───────────────────────── 设置与元数据 ─────────────────────────

  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
    if (!row) return fallback;
    try {
      return JSON.parse(String(row.value));
    } catch {
      return fallback;
    }
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), JSON.stringify(value));
  }

  getMeta(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(String(key));
    return row ? String(row.value) : fallback;
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO index_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(key), String(value));
  }

  /** 运行概览统计（状态页展示）。 */
  stats() {
    const bases = Number(this.db.prepare('SELECT COUNT(*) AS n FROM bases').get()?.n) || 0;
    const docs = Number(this.db.prepare('SELECT COUNT(*) AS n FROM documents').get()?.n) || 0;
    const chunks = Number(this.db.prepare('SELECT COUNT(*) AS n FROM chunk').get()?.n) || 0;
    const providers = Number(this.db.prepare('SELECT COUNT(*) AS n FROM providers').get()?.n) || 0;
    return { bases, documents: docs, chunks, providers };
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }
}

function rowToProvider(r) {
  return {
    id: String(r.id),
    kind: String(r.kind),
    name: String(r.name),
    endpoint: String(r.endpoint),
    apiKey: String(r.api_key),
    model: String(r.model),
    dim: Number(r.dim) || 0,
    enabled: Number(r.enabled) === 1,
    status: String(r.status),
    latencyMs: Number(r.latency_ms) || 0,
    error: String(r.error),
    suggestion: String(r.suggestion),
    checkedAt: Number(r.checked_at) || 0,
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
  };
}

function rowToBase(r) {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description),
    status: String(r.status),
    indexDim: Number(r.index_dim) || 0,
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
  };
}

function rowToDocument(r) {
  return {
    id: String(r.id),
    baseId: String(r.base_id),
    title: String(r.title),
    sourceType: String(r.source_type),
    sourcePath: String(r.source_path),
    mimeType: String(r.mime_type),
    pageCount: Number(r.page_count) || 0,
    charCount: Number(r.char_count) || 0,
    chunkCount: Number(r.chunk_count) || 0,
    contentHash: String(r.content_hash),
    status: String(r.status),
    error: String(r.error),
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
  };
}

function rowToCandidate(r) {
  let embedding;
  const raw = String(r.embedding ?? '');
  if (raw !== '') {
    try {
      const parsed = JSON.parse(raw);
      embedding = Array.isArray(parsed) ? parsed : undefined;
    } catch {
      embedding = undefined;
    }
  }
  return {
    id: String(r.id),
    documentId: String(r.document_id),
    baseId: String(r.base_id),
    chunkIndex: Number(r.chunk_index) || 0,
    text: String(r.text),
    charStart: Number(r.char_start) || 0,
    charEnd: Number(r.char_end) || 0,
    lineStart: Number(r.line_start) || 0,
    lineEnd: Number(r.line_end) || 0,
    pageNo: Number(r.page_no) || 0,
    embedding,
    dim: Number(r.dim) || 0,
    documentTitle: String(r.doc_title ?? ''),
    sourcePath: String(r.doc_path ?? ''),
    sourceType: String(r.doc_source_type ?? ''),
  };
}
