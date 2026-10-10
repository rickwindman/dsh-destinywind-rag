/**
 * 单元测试：分块器（段落优先、句子兜底、重叠、偏移定位）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, splitParagraphs, splitSentences, lineNumberAt } from '../lib/chunk.js';

test('splitParagraphs：按分隔符切分并去空', () => {
  assert.deepEqual(splitParagraphs('a\n\nb\n\n\n\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitParagraphs('   '), []);
});

test('splitSentences：按句号切分且不超预算', () => {
  const out = splitSentences('第一句。第二句！第三句？', 100);
  assert.ok(out.length >= 1);
  assert.ok(out.every((s) => s.length <= 100));
});

test('splitSentences：单句超预算时硬切', () => {
  const out = splitSentences('甲'.repeat(250), 100);
  assert.ok(out.length >= 3);
  assert.ok(out.every((s) => s.length <= 100));
});

test('chunkText：空文本返回空数组', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n  '), []);
});

test('chunkText：短文本合成单块', () => {
  const chunks = chunkText('这是一段很短的内容。', { chunkSize: 800, chunkOverlap: 0 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 0);
  assert.ok(chunks[0].text.includes('很短的内容'));
});

test('chunkText：长文本被切成多块且每块不超预算（允许重叠部分）', () => {
  const para = '这是一段用于测试的中文内容，需要足够长才能触发切分逻辑。'.repeat(20);
  const text = Array.from({ length: 6 }, () => para).join('\n\n');
  const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 50 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    // 重叠会加回上一块的尾部，所以放宽到 chunkSize + overlap。
    assert.ok(c.text.length <= 300 + 50 + 1, `块 ${c.index} 长度 ${c.text.length} 超出预算`);
  }
});

test('chunkText：重叠生效（后一块包含前一块尾部片段）', () => {
  const text = ['甲'.repeat(100), '乙'.repeat(100), '丙'.repeat(100)].join('\n\n');
  const chunks = chunkText(text, { chunkSize: 150, chunkOverlap: 30 });
  if (chunks.length >= 2) {
    const tail = chunks[0].text.slice(-30);
    assert.ok(chunks[1].text.startsWith(tail), '第二块应以第一块尾部开头（重叠）');
  }
});

test('chunkText：charStart/charEnd 可用于回溯原文', () => {
  const text = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
  const chunks = chunkText(text, { chunkSize: 800, chunkOverlap: 0 });
  for (const c of chunks) {
    assert.ok(c.charStart >= 0);
    assert.ok(c.charEnd <= text.length);
    assert.ok(c.charEnd > c.charStart);
  }
});

test('chunkText：smartChunk=false 时按固定长度硬切', () => {
  const text = '甲'.repeat(1000);
  const chunks = chunkText(text, { chunkSize: 300, chunkOverlap: 0, smartChunk: false });
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.text.length <= 300));
});

test('lineNumberAt：正确推算行号', () => {
  const text = 'line1\nline2\nline3';
  assert.equal(lineNumberAt(text, 0), 1);
  assert.equal(lineNumberAt(text, 6), 2);
  assert.equal(lineNumberAt(text, 12), 3);
  // 越界不抛错
  assert.equal(lineNumberAt(text, 9999), 3);
});

test('chunkText：index 从 0 连续递增', () => {
  const text = Array.from({ length: 10 }, (_, i) => `第${i}段内容。`).join('\n\n');
  const chunks = chunkText(text, { chunkSize: 30, chunkOverlap: 0 });
  chunks.forEach((c, i) => assert.equal(c.index, i));
});
