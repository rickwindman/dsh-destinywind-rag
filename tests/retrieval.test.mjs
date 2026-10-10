/**
 * 单元测试：检索核心（分词、BM25、余弦、RRF 融合、MMR、去重截断）。
 * 纯函数，无 IO。运行：node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  buildBm25,
  normalizeBm25,
  cosineSimilarity,
  reciprocalRankFusion,
  rank,
  dedupeAndTruncate,
  RRF_K,
} from '../lib/retrieval.js';

test('tokenize：拉丁词小写化，CJK 走 bigram', () => {
  assert.deepEqual(tokenize('Hello World'), ['hello', 'world']);
  // 「知识库检索」→ 知识 / 识库 / 库检 / 检索
  assert.deepEqual(tokenize('知识库检索'), ['知识', '识库', '库检', '检索']);
});

test('tokenize：单个 CJK 字保留为单字（短查询仍可命中）', () => {
  assert.deepEqual(tokenize('猫'), ['猫']);
});

test('tokenize：混合中英文', () => {
  const tokens = tokenize('RAG 混合检索 v2');
  assert.ok(tokens.includes('rag'));
  assert.ok(tokens.includes('v2'));
  assert.ok(tokens.includes('混合'));
  assert.ok(tokens.includes('检索'));
});

test('tokenize：空输入返回空数组，不抛错', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
});

test('normalizeBm25：映射到 [0,1) 且单调', () => {
  assert.equal(normalizeBm25(0), 0);
  assert.equal(normalizeBm25(-1), 0);
  assert.ok(normalizeBm25(1) < 1);
  assert.ok(normalizeBm25(10) > normalizeBm25(1));
  assert.ok(normalizeBm25(10) < 1);
});

test('buildBm25：相关文档得分高于无关文档', () => {
  const docs = [
    { id: 'a', text: '部署环境要求：推荐 8 核 CPU、16 GB 内存' },
    { id: 'b', text: '今天天气不错，适合出去散步' },
  ];
  const scorer = buildBm25(docs);
  const tokens = tokenize('部署环境');
  assert.ok(scorer.score('a', tokens) > scorer.score('b', tokens));
  assert.equal(scorer.score('b', tokens), 0);
});

test('cosineSimilarity：同向为 1，正交为 0，长度不符为 0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test('reciprocalRankFusion：两路都靠前的 id 融合分最高', () => {
  const fused = reciprocalRankFusion([['a', 'b', 'c'], ['a', 'c', 'b']]);
  assert.ok(fused.get('a') > fused.get('b'));
  assert.ok(fused.get('a') > fused.get('c'));
  // 第 1 名的贡献 = 1/(K+1)
  assert.ok(Math.abs(fused.get('a') - 2 / (RRF_K + 1)) < 1e-9);
});

test('reciprocalRankFusion：权重可放大某一路的拉力', () => {
  // 两个 id 分别只出现在一路，便于单独比较权重效果。
  const plain = reciprocalRankFusion([['a'], ['b']]);
  const weighted = reciprocalRankFusion([['a'], ['b']], [2, 1]);
  assert.ok(weighted.get('a') > plain.get('a'), '被加权的第一路分数应升高');
  // 第二路权重仍为 1，分数不应变化。
  assert.ok(Math.abs(weighted.get('b') - plain.get('b')) < 1e-12);
});

test('rank：无查询向量时自动降级为词法检索（不返回空）', () => {
  const candidates = [
    { id: 'a', text: '部署环境要求：推荐 8 核 CPU' },
    { id: 'b', text: '无关内容' },
  ];
  const hits = rank('部署环境', candidates, { mode: 'auto', topK: 5, threshold: 0, mmr: false, mmrLambda: 0 });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, 'a');
});

test('rank：mode=vector 但无向量时也降级为词法（避免空结果）', () => {
  const candidates = [{ id: 'a', text: '部署环境要求' }];
  const hits = rank('部署', candidates, { mode: 'vector', topK: 5, threshold: 0, mmr: false, mmrLambda: 0 });
  assert.equal(hits.length, 1);
});

test('rank：有查询向量时走 hybrid，并给出两路分数', () => {
  const candidates = [
    { id: 'a', text: '部署环境要求：推荐 8 核 CPU', embedding: [1, 0] },
    { id: 'b', text: '无关内容', embedding: [0, 1] },
  ];
  const hits = rank('部署环境', candidates, {
    mode: 'hybrid', topK: 5, threshold: 0, mmr: false, mmrLambda: 0, queryVector: [1, 0],
  });
  assert.equal(hits[0].id, 'a');
  assert.ok(hits[0].vectorScore > 0);
  assert.ok(hits[0].lexicalScore > 0);
});

test('rank：阈值过滤生效', () => {
  const candidates = [
    { id: 'a', text: '部署环境', embedding: [1, 0] },
    { id: 'b', text: '部署', embedding: [0.2, 0.9] },
  ];
  const hits = rank('部署环境', candidates, {
    mode: 'hybrid', topK: 5, threshold: 0.9, mmr: false, mmrLambda: 0, queryVector: [1, 0],
  });
  assert.ok(hits.every((h) => h.score >= 0.9));
});

test('rank：topK 截断生效', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, text: `部署环境 ${i}` }));
  const hits = rank('部署', candidates, { mode: 'lexical', topK: 3, threshold: 0, mmr: false, mmrLambda: 0 });
  assert.equal(hits.length, 3);
});

test('dedupeAndTruncate：同文档超限时被丢弃', () => {
  const hits = [
    { id: '1', documentId: 'd1', text: 'a'.repeat(10) },
    { id: '2', documentId: 'd1', text: 'b'.repeat(10) },
    { id: '3', documentId: 'd2', text: 'c'.repeat(10) },
  ];
  const kept = dedupeAndTruncate(hits, { maxChars: 1000, maxPerDocument: 1 });
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((h) => h.documentId), ['d1', 'd2']);
});

test('dedupeAndTruncate：超字符预算时截断并打标记', () => {
  const hits = [{ id: '1', documentId: 'd1', text: 'x'.repeat(100) }];
  const kept = dedupeAndTruncate(hits, { maxChars: 30, maxPerDocument: 5 });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text.length, 30);
  assert.equal(kept[0].truncated, true);
});
