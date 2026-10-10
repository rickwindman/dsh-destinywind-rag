/**
 * 复审修复的回归测试：每个用例对应复审中确认的一个缺陷。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { KnowledgeService } from '../lib/service.js';

async function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** 起一个返回固定维度的向量桩服务。 */
async function withStub(dim, fn) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const data = parsed.input.map((_, i) => ({ index: i, embedding: new Array(dim).fill(0.5) }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    await closeServer(server);
  }
}

function memService() {
  return new KnowledgeService({ storePath: ':memory:' });
}

test('复审R1: 换绑到 dim 未知的 provider 时应标记需重建', async () => {
  await withStub(4, async (endpoint4) => {
    const svc = memService();
    const p4 = svc.createProvider({ kind: 'openai', name: '4维', endpoint: endpoint4, model: 'm4', dim: 4 });
    const base = svc.createBase({ name: '库', providerId: p4.id });
    await svc.addText({ baseId: base.id, title: 't', text: '部署环境要求推荐 8 核 CPU。' });
    assert.equal(svc.listBases()[0].status, 'ready');

    // 换绑到一个从未测试（dim=0）的 provider
    const pUnknown = svc.createProvider({ kind: 'openai', name: '未测试', endpoint: 'http://127.0.0.1:9/v1', model: 'm', dim: 0 });
    svc.bindProvider(base.id, pUnknown.id);
    assert.equal(svc.listBases()[0].status, 'stale', '换到维度未知的 provider 必须要求重建');
    svc.close();
  });
});

test('复审R2: 同一 provider 换绑到自身（无变化）不应触发重建', async () => {
  await withStub(4, async (endpoint4) => {
    const svc = memService();
    const p = svc.createProvider({ kind: 'openai', name: 'p', endpoint: endpoint4, model: 'm', dim: 4 });
    const base = svc.createBase({ name: '库', providerId: p.id });
    await svc.addText({ baseId: base.id, title: 't', text: '部署环境要求。' });
    svc.bindProvider(base.id, p.id, 'embedding');
    assert.equal(svc.listBases()[0].status, 'ready', '重复绑定同一 provider 不应标记 stale');
    svc.close();
  });
});

test('复审R3: 修改 provider 的模型名后，绑定它的库应标记需重建', async () => {
  const svc = memService();
  const p = svc.createProvider({ kind: 'openai', name: 'p', endpoint: 'http://127.0.0.1:9/v1', model: '旧模型', dim: 4 });
  const b1 = svc.createBase({ name: '库1', providerId: p.id });
  const b2 = svc.createBase({ name: '库2', providerId: p.id });
  await svc.addText({ baseId: b1.id, title: 't', text: '部署环境要求。' });

  svc.updateProvider(p.id, { model: '完全不同的新模型' });
  assert.equal(svc.listBases().find((b) => b.id === b1.id).status, 'stale', '改模型名后应标记 stale');
  assert.equal(svc.listBases().find((b) => b.id === b2.id).status, 'stale', '第二个绑定的库也应标记 stale');
  svc.close();
});

test('复审R4: 改 provider 名称（非模型）不应触发重建', async () => {
  const svc = memService();
  const p = svc.createProvider({ kind: 'openai', name: '旧名字', endpoint: 'http://127.0.0.1:9/v1', model: 'm', dim: 4 });
  const base = svc.createBase({ name: '库', providerId: p.id });
  await svc.addText({ baseId: base.id, title: 't', text: '部署环境要求。' });

  svc.updateProvider(p.id, { name: '只是改个显示名' });
  assert.equal(svc.listBases()[0].status, 'ready', '只改显示名不应标记 stale');
  svc.close();
});

test('复审R5: 换绑后未重建就导入 → 应拒绝并提示先重建（防止混合维度索引）', async () => {
  await withStub(4, async (e4) => {
    await withStub(8, async (e8) => {
      const svc = memService();
      const p4 = svc.createProvider({ kind: 'openai', name: '4维', endpoint: e4, model: 'm4', dim: 4 });
      const p8 = svc.createProvider({ kind: 'openai', name: '8维', endpoint: e8, model: 'm8', dim: 8 });
      const base = svc.createBase({ name: '库', providerId: p4.id });
      await svc.addText({ baseId: base.id, title: '旧文档', text: '旧文档内容部署环境。' });

      svc.bindProvider(base.id, p8.id); // 标记 stale，但不重建
      await assert.rejects(
        () => svc.addText({ baseId: base.id, title: '新文档', text: '新文档内容检索关键词。' }),
        (err) => {
          assert.match(err.message, /维度.*不一致/);
          assert.match(err.suggestion, /重建索引/);
          return true;
        },
        '混合维度导入必须被拒绝',
      );

      // 重建后即可正常导入
      await svc.reindexBase(base.id);
      const r = await svc.addText({ baseId: base.id, title: '新文档', text: '新文档内容检索关键词。' });
      assert.equal(r.embedded, true);
      const cands = svc.store.loadCandidates(base.id);
      assert.equal(new Set(cands.map((c) => c.dim)).size, 1, '重建后维度必须统一');
      svc.close();
    }, 8);
  }, 4);
});

test('复审R6: 向量化失败的降级导入（dim=0）不得清零已有索引维度', async () => {
  const svc = memService();
  // 指向不可达端口 → 导入时向量化失败 → dim=0
  const p = svc.createProvider({ kind: 'openai', name: '坏端点', endpoint: 'http://127.0.0.1:1/v1', model: 'm', dim: 4 });
  const base = svc.createBase({ name: '库', providerId: p.id, dim: 0 });
  // 先用真实维度「建库」（模拟此前成功导入过的状态）
  svc.store.setBaseIndexDim(base.id, 4);

  await svc.addText({ baseId: base.id, title: 't', text: '部署环境要求。' });
  assert.equal(svc.listBases()[0].indexDim, 4, '降级导入不得把 indexDim 清零');
  svc.close();
});

test('复审R7: reindex 全库只加载一次候选（O(M) 而非 O(N×M)）', async () => {
  const svc = memService();
  const base = svc.createBase({ name: '库' });
  for (let i = 0; i < 5; i++) {
    await svc.addText({ baseId: base.id, title: `doc${i}`, text: `文档${i}的内容部署环境。` });
  }
  let loads = 0;
  const orig = svc.store.loadCandidates.bind(svc.store);
  svc.store.loadCandidates = (id) => { loads += 1; return orig(id); };
  const report = await svc.reindexBase(base.id);
  assert.equal(loads, 1, `全库候选只应加载一次，实际 ${loads}`);
  assert.equal(report.chunks, 5);
  svc.close();
});

test('复审R8: 重建期间库状态保持 indexing，完成后才写 ready/partial', async () => {
  const svc = memService();
  const base = svc.createBase({ name: '库' });
  await svc.addText({ baseId: base.id, title: 't', text: '部署环境要求。' });

  const states = [];
  const orig = svc.store.setBaseStatus.bind(svc.store);
  svc.store.setBaseStatus = (id, s) => { states.push(s); return orig(id, s); };

  await svc.reindexBase(base.id);
  // 期望序列：indexing（开头）→ ready（结尾），中途不得出现 ready
  assert.equal(states[0], 'indexing', '开头应设为 indexing');
  assert.equal(states[states.length - 1], 'ready', '结尾应为 ready');
  assert.ok(!states.slice(1, -1).includes('ready'), '中途不得把状态写回 ready');
  svc.close();
});

test('复审R9: 每库配置覆盖真实生效（search 用各库自己的 topK）', async () => {
  const svc = memService();
  const b1 = svc.createBase({ name: '库1' });
  const b2 = svc.createBase({ name: '库2' });
  for (let i = 0; i < 4; i++) {
    await svc.addText({ baseId: b1.id, title: `甲${i}`, text: `部署流程内容${i}。` });
    await svc.addText({ baseId: b2.id, title: `乙${i}`, text: `部署流程内容${i}。` });
  }
  // 库1 限定 topK=1，库2 保持默认 6
  svc.store.setBaseOverrides(b1.id, { topK: 1 });
  const r = await svc.search({ query: '部署流程' });
  const fromB1 = r.hits.filter((h) => h.baseId === b1.id);
  const fromB2 = r.hits.filter((h) => h.baseId === b2.id);
  assert.equal(fromB1.length, 1, `库1 每库 topK=1 应只出 1 条，实际 ${fromB1.length}`);
  assert.ok(fromB2.length > 1, '库2 无覆盖应按全局 topK 召回多条');
  svc.close();
});

test('复审R10: base_overrides 持久化与空值恢复继承', () => {
  const svc = memService();
  const base = svc.createBase({ name: '库' });
  svc.store.setBaseOverrides(base.id, { topK: 3, chunkSize: '' });
  assert.deepEqual(svc.store.getBaseOverrides(base.id), { topK: 3 });
  svc.store.setBaseOverrides(base.id, { topK: '' });
  assert.deepEqual(svc.store.getBaseOverrides(base.id), {}, '空值应被清除（恢复继承）');
  svc.close();
});

test('复审R11: addDocument 单事务——分块写入失败时文档不落库', () => {
  const svc = memService();
  const base = svc.createBase({ name: '库' });
  // 让 documents 行先写入成功、随后 chunk 插入必然违反主键约束：
  // 两个分块用同一个显式 id → 第二条 INSERT 触发 UNIQUE 冲突 → 事务回滚。
  assert.throws(
    () => svc.store.addDocument({
      baseId: base.id, title: 't', text: '内容',
      id: 'doc_fixed',
      chunks: [
        { id: 'ck_dup', index: 0, text: '第一块' },
        { id: 'ck_dup', index: 1, text: '第二块（重复主键）' },
      ],
      dim: 0,
      skipDuplicates: false,
    }),
    /UNIQUE|constraint/i,
  );
  assert.equal(svc.store.stats().documents, 0, '事务回滚后不应留下文档记录');
  assert.equal(svc.store.countChunks(base.id), 0, '也不应留下分块');
  assert.equal(svc.store.getBase(base.id).docCount, 0);
  svc.close();
});

test('复审R12: lineStart/lineEnd 与 chunk 偏移在重叠分块下仍正确', () => {
  const svc = memService();
  const base = svc.createBase({ name: '库' });
  const text = Array.from({ length: 30 }, (_, i) => `第${i}行内容部署环境说明。`).join('\n');
  svc.addText({ baseId: base.id, title: 't', text });
  const cands = svc.store.loadCandidates(base.id);
  for (const c of cands) {
    assert.ok(c.lineStart >= 1 && c.lineStart <= 30, `lineStart=${c.lineStart} 越界`);
    assert.ok(c.lineEnd >= c.lineStart, `lineEnd=${c.lineEnd} 小于 lineStart`);
  }
  svc.close();
});
