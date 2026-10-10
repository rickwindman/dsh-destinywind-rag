/**
 * 单元测试：存储层（SQLite + FTS5 + provider 注册表 + 多对多绑定）。
 * 使用 :memory: 数据库，不落盘。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeStore, contentHash } from '../lib/store.js';

function freshStore() {
  return new KnowledgeStore(':memory:');
}

test('store：建表成功且统计为空', () => {
  const s = freshStore();
  const stats = s.stats();
  assert.deepEqual(stats, { bases: 0, documents: 0, chunks: 0, providers: 0 });
  s.close();
});

test('store：provider CRUD', () => {
  const s = freshStore();
  const p = s.createProvider({ kind: 'openai', name: '网关', endpoint: 'https://x/v1', model: 'm', dim: 1536 });
  assert.ok(p.id.startsWith('pv_'));
  assert.equal(p.kind, 'openai');
  assert.equal(p.dim, 1536);

  const updated = s.updateProvider(p.id, { name: '新名字' });
  assert.equal(updated.name, '新名字');

  assert.equal(s.listProviders().length, 1);
  s.deleteProvider(p.id);
  assert.equal(s.listProviders().length, 0);
  s.close();
});

test('store：recordProviderStatus 记录状态灯与延迟', () => {
  const s = freshStore();
  const p = s.createProvider({ kind: 'openai', name: 'x', model: 'm' });
  s.recordProviderStatus(p.id, { ok: true, latencyMs: 123, dim: 768 });
  const after = s.getProvider(p.id);
  assert.equal(after.status, 'ok');
  assert.equal(after.latencyMs, 123);
  s.close();
});

test('store：记录失败原因与建议', () => {
  const s = freshStore();
  const p = s.createProvider({ kind: 'ollama', name: 'x', model: 'bge-m3' });
  s.recordProviderStatus(p.id, { ok: false, error: '连接被拒绝', suggestion: '请启动 Ollama' });
  const after = s.getProvider(p.id);
  assert.equal(after.status, 'error');
  assert.equal(after.error, '连接被拒绝');
  assert.equal(after.suggestion, '请启动 Ollama');
  s.close();
});

test('store：多对多绑定——一个 provider 可被多个知识库复用', () => {
  const s = freshStore();
  const p = s.createProvider({ kind: 'onnx', name: '本地', model: 'qwen3' });
  const b1 = s.createBase({ name: '库1' });
  const b2 = s.createBase({ name: '库2' });
  s.bindProvider(b1.id, p.id);
  s.bindProvider(b2.id, p.id);

  assert.equal(s.getActiveProvider(b1.id).id, p.id);
  assert.equal(s.getActiveProvider(b2.id).id, p.id);
  assert.equal(s.listBasesBoundTo(p.id).length, 2);
  s.close();
});

test('store：同一知识库换绑时旧绑定失效（role 内唯一 active）', () => {
  const s = freshStore();
  const p1 = s.createProvider({ kind: 'onnx', name: 'A', model: 'm1' });
  const p2 = s.createProvider({ kind: 'ollama', name: 'B', model: 'm2' });
  const b = s.createBase({ name: '库' });
  s.bindProvider(b.id, p1.id);
  assert.equal(s.getActiveProvider(b.id).id, p1.id);

  s.bindProvider(b.id, p2.id);
  assert.equal(s.getActiveProvider(b.id).id, p2.id, '换绑后应取新 provider');
  s.close();
});

test('store：listBindings 返回绑定关系表所需字段', () => {
  const s = freshStore();
  const p = s.createProvider({ kind: 'openai', name: '网关', model: 'text-embedding-3-small', dim: 1536 });
  const b = s.createBase({ name: '产品手册', providerId: p.id });
  s.setBaseIndexDim(b.id, 1024);

  const bindings = s.listBindings();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].baseName, '产品手册');
  assert.equal(bindings[0].providerName, '网关');
  assert.equal(bindings[0].providerDim, 1536);
  assert.equal(bindings[0].indexDim, 1024, '维度不一致应可被 UI 检测出来');
  s.close();
});

test('store：删除 provider 会把关联知识库标记为需重建', () => {
  const s = freshStore();
  const p = s.createProvider({ kind: 'onnx', name: 'A', model: 'm' });
  const b = s.createBase({ name: '库', providerId: p.id });
  assert.equal(s.getBase(b.id).status, 'ready');

  const r = s.deleteProvider(p.id);
  assert.deepEqual(r.affectedBases, [b.id]);
  assert.equal(s.getBase(b.id).status, 'stale');
  assert.equal(s.getActiveProvider(b.id), null);
  s.close();
});

test('store：知识库 CRUD 与 docCount', () => {
  const s = freshStore();
  const b = s.createBase({ name: '测试库' });
  assert.equal(b.name, '测试库');
  assert.equal(b.docCount, 0);

  s.addDocument({ baseId: b.id, title: 'd1', text: '内容一' });
  assert.equal(s.getBase(b.id).docCount, 1);

  const renamed = s.renameBase(b.id, '改名后');
  assert.equal(renamed.name, '改名后');

  s.deleteBase(b.id);
  assert.equal(s.listBases().length, 0);
  assert.equal(s.stats().documents, 0, '级联删除文档');
  s.close();
});

test('store：addDocument 写入分块并建立 FTS 索引', () => {
  const s = freshStore();
  const b = s.createBase({ name: '库' });
  const r = s.addDocument({
    baseId: b.id,
    title: '部署指南',
    text: '部署环境要求 8 核 CPU',
    chunks: [
      { index: 0, text: '部署环境要求 8 核 CPU', charStart: 0, charEnd: 15, lineStart: 1, lineEnd: 1 },
    ],
    dim: 4,
  });
  assert.equal(r.skipped, false);
  assert.equal(r.chunks, 1);
  assert.equal(s.countChunks(b.id), 1);
  assert.equal(s.getBase(b.id).indexDim, 4);

  const fts = s.searchFts(b.id, '部署');
  assert.equal(fts.length, 1, 'FTS5 应能命中中文（unicode61 + 应用层兜底）');
  s.close();
});

test('store：同内容重复导入被跳过', () => {
  const s = freshStore();
  const b = s.createBase({ name: '库' });
  const input = { baseId: b.id, title: 't', text: '完全相同的内容', chunks: [{ index: 0, text: '完全相同的内容' }] };
  const first = s.addDocument(input);
  const second = s.addDocument(input);
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true, 'content_hash 相同应跳过');
  assert.equal(s.stats().documents, 1);
  s.close();
});

test('store：skipDuplicates=false 时允许重复写入', () => {
  const s = freshStore();
  const b = s.createBase({ name: '库' });
  const input = { baseId: b.id, title: 't', text: '同内容', chunks: [{ index: 0, text: '同内容' }], skipDuplicates: false };
  s.addDocument(input);
  s.addDocument(input);
  assert.equal(s.stats().documents, 2);
  s.close();
});

test('store：loadCandidates 还原向量数组', () => {
  const s = freshStore();
  const b = s.createBase({ name: '库' });
  s.addDocument({
    baseId: b.id, title: 't', text: '内容',
    chunks: [{ index: 0, text: '内容', embedding: [0.1, 0.2, 0.3] }],
    dim: 3,
  });
  const candidates = s.loadCandidates(b.id);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].embedding, [0.1, 0.2, 0.3]);
  assert.equal(candidates[0].dim, 3);
  s.close();
});

test('store：无向量的分块 embedding 为 undefined（触发词法降级）', () => {
  const s = freshStore();
  const b = s.createBase({ name: '库' });
  s.addDocument({ baseId: b.id, title: 't', text: '内容', chunks: [{ index: 0, text: '内容' }], dim: 0 });
  const candidates = s.loadCandidates(b.id);
  assert.equal(candidates[0].embedding, undefined);
  s.close();
});

test('store：deleteDocument 级联清理分块与 FTS', () => {
  const s = freshStore();
  const b = s.createBase({ name: '库' });
  const r = s.addDocument({ baseId: b.id, title: 't', text: '待删除内容', chunks: [{ index: 0, text: '待删除内容' }] });
  assert.equal(s.countChunks(b.id), 1);

  s.deleteDocument(r.document.id);
  assert.equal(s.countChunks(b.id), 0);
  assert.equal(s.stats().documents, 0);
  assert.equal(s.searchFts(b.id, '待删除').length, 0, 'FTS 条目应同步删除');
  s.close();
});

test('store：searchFts 对 FTS 保留字符不抛错', () => {
  const s = freshStore();
  const b = s.createBase({ name: '库' });
  s.addDocument({ baseId: b.id, title: 't', text: '内容', chunks: [{ index: 0, text: '内容' }] });
  // 这些字符会破坏 FTS5 查询语法，实现必须吞掉错误并返回空数组。
  assert.doesNotThrow(() => s.searchFts(b.id, 'a"b'));
  assert.doesNotThrow(() => s.searchFts(b.id, 'NEAR('));
  assert.doesNotThrow(() => s.searchFts(b.id, '*'));
  s.close();
});

test('store：设置读写（JSON 往返）', () => {
  const s = freshStore();
  assert.deepEqual(s.getSetting('missing', { a: 1 }), { a: 1 });
  s.setSetting('cfg', { scope: 'all', n: 3 });
  assert.deepEqual(s.getSetting('cfg'), { scope: 'all', n: 3 });
  s.setSetting('cfg', { scope: 'auto' });
  assert.deepEqual(s.getSetting('cfg'), { scope: 'auto' });
  s.close();
});

test('store：index_meta 读写', () => {
  const s = freshStore();
  assert.equal(s.getMeta('dim', null), null);
  s.setMeta('dim', 1024);
  assert.equal(s.getMeta('dim'), '1024');
  s.close();
});

test('store：rebuildFts 不抛错', () => {
  const s = freshStore();
  const b = s.createBase({ name: '库' });
  s.addDocument({ baseId: b.id, title: 't', text: '内容', chunks: [{ index: 0, text: '内容' }] });
  assert.doesNotThrow(() => s.rebuildFts());
  s.close();
});

test('contentHash：相同内容哈希一致，不同内容不同', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
  assert.equal(contentHash('').length, 32);
});

test('store：落盘后重新打开数据仍在（持久化）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'rag-store-'));
  const file = join(dir, 'test.sqlite');
  try {
    const s1 = new KnowledgeStore(file);
    const b = s1.createBase({ name: '持久化库' });
    s1.createProvider({ kind: 'onnx', name: 'p', model: 'm' });
    s1.close();

    const s2 = new KnowledgeStore(file);
    assert.equal(s2.listBases().length, 1);
    assert.equal(s2.listBases()[0].name, '持久化库');
    assert.equal(s2.listProviders().length, 1);
    s2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
