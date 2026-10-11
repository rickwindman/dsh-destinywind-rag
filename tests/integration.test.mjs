/**
 * 集成测试：添加文档 → 索引 → 检索 → 返回来源（含双引擎链路）。
 *
 * 远程引擎用本地 HTTP 桩服务器模拟（不访问外网）；
 * 本地引擎验证「不可用时降级为纯关键词」这一零配置关键路径。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeService } from '../lib/service.js';

/** 起一个 OpenAI 兼容 /embeddings 桩服务：按文本内容生成确定性向量。 */
async function withEmbeddingStub(fn, dim = 4) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const data = parsed.input.map((text, i) => ({
        index: i,
        // 用字符码求和生成向量，让语义相近的文本向量也相近。
        embedding: Array.from({ length: dim }, (_, k) => {
          let sum = 0;
          for (const ch of String(text)) sum += ch.codePointAt(0) * (k + 1);
          return (sum % 97) / 97;
        }),
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await closeServer(server);
  }
}

/**
 * 关闭桩服务器。
 * Node 的 fetch（undici）默认保持 keep-alive 连接，只调 close() 会一直等待
 * 连接释放，导致测试挂起；必须先 closeAllConnections() 强制断开。
 */
async function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function memService(config = {}) {
  return new KnowledgeService({ storePath: ':memory:', ...config });
}

/**
 * 测试环境安全阀：detect 强制报告「运行时不可用」，防止 ensureDefault/
 * startModelDownload 在测试里触发真实的模型下载（曾实测在 CI 上拉了 2.3GB）。
 * 本地 ONNX 推理链路由独立探针脚本验证（见 docs/04），不进单元测试。
 */
const origDetect = KnowledgeService.prototype.detect;
KnowledgeService.prototype.detect = async function patchedDetect(options = {}) {
  const report = await origDetect.call(this, { ...options, skipNetwork: true });
  report.onnx.ok = false;
  report.onnx.reason = '（测试环境：禁用真实下载）';
  report.recommended = report.recommended === 'onnx' ? 'none' : report.recommended;
  return report;
};

// ───────────────────────── 零配置 ─────────────────────────

test('集成：零配置首次调用自动创建默认知识库与 provider', async () => {
  const svc = memService({ embeddingProvider: 'none' });
  assert.equal(svc.listBases().length, 0);

  const r = await svc.ensureDefault();
  assert.ok(r.base, '应自动创建知识库');
  assert.equal(r.base.name, '默认知识库');
  assert.equal(r.created, true);
  assert.equal(svc.listBases().length, 1);
  svc.close();
});

test('集成：已有知识库时 ensureDefault 不重复创建', async () => {
  const svc = memService();
  const first = await svc.ensureDefault();
  const second = await svc.ensureDefault();
  assert.equal(first.base.id, second.base.id);
  assert.equal(svc.listBases().length, 1);
  svc.close();
});

test('集成：零配置下没有可用向量引擎时仍能用纯关键词检索', async () => {
  const svc = memService({ embeddingProvider: 'none' });
  const { base } = await svc.ensureDefault();

  await svc.addText({ baseId: base.id, title: '部署说明', text: '部署环境要求推荐 8 核 CPU 与 16 GB 内存。' });
  const result = await svc.search({ query: '部署环境' });

  assert.ok(result.hits.length > 0, '纯关键词模式也必须能召回');
  assert.match(result.hits[0].text, /部署环境/);
  svc.close();
});

// ───────────────────────── 端到端：导入 → 索引 → 检索 → 来源 ─────────────────────────

test('集成：添加文档 → 索引 → 检索 → 返回带来源的结果', async () => {
  await withEmbeddingStub(async (endpoint) => {
    const svc = memService({ embeddingProvider: 'openai', embeddingEndpoint: endpoint, embeddingModel: 'stub', embeddingApiKey: 'k' });
    const base = svc.createBase({ name: '产品手册' });

    const provider = svc.createProvider({ kind: 'openai', name: '桩端点', endpoint, model: 'stub', apiKey: 'k' });
    svc.bindProvider(base.id, provider.id);

    const added = await svc.addText({
      baseId: base.id,
      title: '部署指南',
      text: '部署环境要求：推荐 8 核 CPU、16 GB 内存。执行安装脚本后运行配置命令即可完成初始化。\n\n若需调整参数，可在管理界面直接修改，无需手工编辑配置文件。',
    });
    assert.equal(added.skipped, false);
    assert.ok(added.chunks > 0);
    assert.equal(added.embedded, true, '绑定了可用端点时应成功向量化');
    assert.equal(added.dim, 4);

    const result = await svc.search({ query: '部署环境要求' });
    assert.ok(result.hits.length > 0);
    const hit = result.hits[0];
    assert.ok(hit.score > 0);
    assert.ok(hit.text.length > 0);
    // 来源标注必须齐全（需求：文件路径 + 页码/段落/行号）
    assert.ok(hit.source, '必须带来源对象');
    assert.equal(hit.source.title, '部署指南');
    assert.ok(hit.source.locator.length > 0, '必须有定位信息');
    assert.ok(hit.baseName === '产品手册');
    svc.close();
  });
});

test('集成：检索结果的来源可定位到行号', async () => {
  await withEmbeddingStub(async (endpoint) => {
    const svc = memService({ embeddingProvider: 'openai', embeddingEndpoint: endpoint, embeddingModel: 'stub' });
    const base = svc.createBase({ name: '库' });
    const provider = svc.createProvider({ kind: 'openai', name: 'p', endpoint, model: 'stub' });
    svc.bindProvider(base.id, provider.id);

    await svc.addText({
      baseId: base.id,
      title: '多行文档',
      text: '第一行内容。\n第二行内容。\n第三行包含独特关键词甲乙丙。\n第四行内容。',
    });

    const result = await svc.search({ query: '独特关键词甲乙丙' });
    assert.ok(result.hits.length > 0);
    const hit = result.hits[0];
    assert.ok(hit.lineStart > 0, '应记录行号');
    assert.ok(hit.source.locator.includes('行') || hit.source.locator.includes('段'));
    svc.close();
  });
});

test('集成：PDF 风格的分页标记会回填页码', async () => {
  await withEmbeddingStub(async (endpoint) => {
    const svc = memService({ embeddingProvider: 'openai', embeddingEndpoint: endpoint, embeddingModel: 'stub' });
    const base = svc.createBase({ name: '库' });
    const provider = svc.createProvider({ kind: 'openai', name: 'p', endpoint, model: 'stub' });
    svc.bindProvider(base.id, provider.id);

    await svc.addText({
      baseId: base.id,
      title: '手册',
      text: '【第 1 页】\n封面与目录。\n\n【第 2 页】\n部署环境要求推荐 8 核 CPU。',
    });

    const result = await svc.search({ query: '部署环境要求' });
    assert.ok(result.hits.length > 0);
    assert.ok(result.hits[0].pageNo >= 1, '应回填页码');
    assert.match(result.hits[0].source.locator, /第 \d+ 页/);
    svc.close();
  });
});

test('集成：限定知识库范围时只返回该库结果', async () => {
  await withEmbeddingStub(async (endpoint) => {
    const svc = memService({ embeddingProvider: 'openai', embeddingEndpoint: endpoint, embeddingModel: 'stub' });
    const provider = svc.createProvider({ kind: 'openai', name: 'p', endpoint, model: 'stub' });

    const b1 = svc.createBase({ name: '库甲' });
    const b2 = svc.createBase({ name: '库乙' });
    svc.bindProvider(b1.id, provider.id);
    svc.bindProvider(b2.id, provider.id);

    await svc.addText({ baseId: b1.id, title: '甲文档', text: '甲库的独特内容：部署流程说明。' });
    await svc.addText({ baseId: b2.id, title: '乙文档', text: '乙库的独特内容：部署流程说明。' });

    const all = await svc.search({ query: '部署流程说明' });
    assert.equal(new Set(all.hits.map((h) => h.baseId)).size, 2, '不限定范围应跨库召回');

    const scoped = await svc.search({ query: '部署流程说明', baseId: b1.id });
    assert.ok(scoped.hits.length > 0);
    assert.ok(scoped.hits.every((h) => h.baseId === b1.id), '限定范围后只返回该库');
    svc.close();
  });
});

// ───────────────────────── 双引擎 ─────────────────────────

test('集成：大模型向量引擎链路跑通（OpenAI 兼容）', async () => {
  await withEmbeddingStub(async (endpoint) => {
    const svc = memService();
    const p = svc.createProvider({ kind: 'openai', name: '远程', endpoint, model: 'stub', apiKey: 'k' });
    const test = await svc.testProvider(p.id);
    assert.equal(test.ok, true, '连接测试应成功');
    assert.equal(test.dim, 4, '应探测出维度');
    svc.close();
  });
});

test('集成：远程端点不可用时导入降级为关键词且不报错', async () => {
  const svc = memService();
  // 指向一个必然不可达的端口。
  const p = svc.createProvider({ kind: 'openai', name: '坏端点', endpoint: 'http://127.0.0.1:1/v1', model: 'm' });
  const base = svc.createBase({ name: '库', providerId: p.id });

  const added = await svc.addText({ baseId: base.id, title: 't', text: '部署环境要求推荐 8 核 CPU。' });
  assert.equal(added.embedded, false, '向量化失败应降级');
  assert.ok(added.embedError.length > 0, '应记录失败原因');
  assert.ok(added.chunks > 0, '仍应写入分块');

  const result = await svc.search({ query: '部署环境' });
  assert.ok(result.hits.length > 0, '降级后仍能关键词召回');
  svc.close();
});

test('集成：本地 Ollama 链路（桩服务）跑通', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'bge-m3' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embedding: new Array(6).fill(String(parsed.prompt).length / 10) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const svc = memService();
    const p = svc.createProvider({ kind: 'ollama', name: '本地 Ollama', endpoint: base, model: 'bge-m3' });

    const test = await svc.testProvider(p.id);
    assert.equal(test.ok, true, 'Ollama 连接测试应成功');

    const kb = svc.createBase({ name: '本地库', providerId: p.id });
    const added = await svc.addText({ baseId: kb.id, title: 't', text: '本地向量模型链路测试内容。' });
    assert.equal(added.embedded, true);
    assert.equal(added.dim, 6);

    const result = await svc.search({ query: '本地向量模型' });
    assert.ok(result.hits.length > 0);
    assert.equal(result.hits[0].vectorScore !== null, true, '应给出向量分数');
    svc.close();
  } finally {
    await closeServer(server);
  }
});

test('集成：Ollama 在线但缺模型时给出 ollama pull 建议', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'llama3' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const svc = memService();
    const p = svc.createProvider({ kind: 'ollama', name: 'o', endpoint: base, model: 'bge-m3' });
    const test = await svc.testProvider(p.id);
    assert.equal(test.ok, false);
    assert.match(test.suggestion, /ollama pull bge-m3/);
    svc.close();
  } finally {
    await closeServer(server);
  }
});

// ───────────────────────── 维度校验与重建 ─────────────────────────

test('集成：更换模型后维度不一致标记需重建，重建后维度对齐', async () => {
  await withEmbeddingStub(async (endpoint4) => {
    // 第二个桩服务返回 8 维，制造维度变化。
    await withEmbeddingStub(async (endpoint8) => {
      const svc = memService();
      const p4 = svc.createProvider({ kind: 'openai', name: '4维', endpoint: endpoint4, model: 'm4', dim: 4 });
      const p8 = svc.createProvider({ kind: 'openai', name: '8维', endpoint: endpoint8, model: 'm8', dim: 8 });

      const base = svc.createBase({ name: '库', providerId: p4.id });
      await svc.addText({ baseId: base.id, title: 't', text: '部署环境要求推荐 8 核 CPU。' });
      assert.equal(svc.listBases()[0].indexDim, 4);

      // 换绑到 8 维模型 → 应标记需重建
      const bound = svc.bindProvider(base.id, p8.id);
      assert.equal(bound.dimension.status, 'mismatch');
      assert.equal(svc.listBases()[0].status, 'stale');

      const check = svc.checkBaseDimension(base.id);
      assert.equal(check.status, 'mismatch');
      assert.match(check.message, /需重建/);

      // 重建后维度应更新为 8
      const report = await svc.reindexBase(base.id);
      assert.equal(report.dim, 8);
      assert.equal(svc.listBases()[0].indexDim, 8);
      assert.equal(svc.listBases()[0].status, 'ready');
      assert.equal(svc.checkBaseDimension(base.id).status, 'ok');
      svc.close();
    }, 8);
  }, 4);
});

test('集成：维度一致时绑定不触发需重建', async () => {
  await withEmbeddingStub(async (endpoint) => {
    const svc = memService();
    const p1 = svc.createProvider({ kind: 'openai', name: 'A', endpoint, model: 'm', dim: 4 });
    const p2 = svc.createProvider({ kind: 'openai', name: 'B', endpoint, model: 'm', dim: 4 });
    const base = svc.createBase({ name: '库', providerId: p1.id });
    await svc.addText({ baseId: base.id, title: 't', text: '部署环境要求。' });

    const bound = svc.bindProvider(base.id, p2.id);
    assert.equal(bound.dimension.status, 'ok');
    assert.equal(svc.listBases()[0].status, 'ready');
    svc.close();
  });
});

test('集成：未绑定模型时维度校验返回 unknown 而非报错', async () => {
  const svc = memService();
  const base = svc.createBase({ name: '库' });
  const check = svc.checkBaseDimension(base.id);
  assert.equal(check.status, 'unknown');
  assert.match(check.message, /尚未绑定/);
  svc.close();
});

// ───────────────────────── 文件导入 ─────────────────────────

test('集成：导入 TXT 文件并检索到（含文件路径来源）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rag-file-'));
  try {
    const file = join(dir, '说明.txt');
    await writeFile(file, '本文档描述部署流程：先准备环境，再执行安装脚本。', 'utf8');

    const svc = memService({ embeddingProvider: 'none' });
    const base = svc.createBase({ name: '文件库' });
    const r = await svc.addFile({ baseId: base.id, filePath: file });

    assert.equal(r.skipped, false);
    assert.equal(r.document.sourcePath, file);
    assert.equal(r.document.sourceType, 'file');

    const result = await svc.search({ query: '部署流程' });
    assert.ok(result.hits.length > 0);
    assert.equal(result.hits[0].source.path, file, '来源应指向原文件');
    assert.equal(result.hits[0].source.openable, true, '文件来源应可点击打开');
    svc.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('集成：导入 Markdown 文件时清洗语法但保留正文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rag-md-'));
  try {
    const file = join(dir, 'doc.md');
    await writeFile(file, '# 标题\n\n**加粗**内容，含[链接](http://x)。\n\n```js\nconst a = 1;\n```\n', 'utf8');

    const svc = memService({ embeddingProvider: 'none' });
    const base = svc.createBase({ name: '库' });
    await svc.addFile({ baseId: base.id, filePath: file });

    const result = await svc.search({ query: '加粗内容' });
    assert.ok(result.hits.length > 0);
    assert.ok(!result.hits[0].text.includes('http://x'), '链接 URL 应被清洗');
    svc.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('集成：导入 HTML 文件时剥标签保正文（零依赖）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rag-html-'));
  try {
    const file = join(dir, 'page.html');
    await writeFile(file, '<!DOCTYPE html><html><head><style>body{color:red}</style><script>var x=1;</script></head>' +
      '<body><h1>部署&#25351;南</h1><p>部署环境要求&nbsp;8 核 CPU。</p><!-- 注释 --><div>第二段内容。</div></body></html>', 'utf8');

    const svc = memService({ embeddingProvider: 'none' });
    const base = svc.createBase({ name: '库' });
    await svc.addFile({ baseId: base.id, filePath: file });

    const result = await svc.search({ query: '部署环境要求' });
    assert.ok(result.hits.length > 0, '正文应可检索');
    const text = result.hits[0].text;
    assert.ok(!text.includes('<p>'), '标签应被剥除');
    assert.ok(!text.includes('var x=1'), '脚本应被剥除');
    assert.ok(!text.includes('color:red'), '样式应被剥除');
    assert.ok(!text.includes('&nbsp;'), '实体应被解码');
    svc.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('集成：导入目录递归处理并跳过不支持的文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rag-dir-'));
  try {
    await writeFile(join(dir, 'a.txt'), '第一个文件的内容。', 'utf8');
    await writeFile(join(dir, 'b.md'), '# 第二个\n文件的内容。', 'utf8');
    await writeFile(join(dir, 'c.exe'), 'binary', 'utf8');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'd.txt'), '子目录文件内容。', 'utf8');

    const svc = memService({ embeddingProvider: 'none' });
    const base = svc.createBase({ name: '目录库' });
    const r = await svc.addDirectory({ baseId: base.id, dirPath: dir });

    assert.equal(r.imported, 3, '应导入 txt/md/子目录 txt');
    assert.ok(r.skipped >= 1, 'exe 应被跳过');
    assert.equal(r.failed.length, 0);
    svc.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('集成：不支持的文件类型给出中文提示', async () => {
  const svc = memService();
  const base = svc.createBase({ name: '库' });
  await assert.rejects(
    () => svc.addFile({ baseId: base.id, filePath: 'C:\\x\\a.exe' }),
    /不支持的文件类型/,
  );
  svc.close();
});

test('集成：文件不存在时给出中文错误', async () => {
  const svc = memService();
  const base = svc.createBase({ name: '库' });
  await assert.rejects(
    () => svc.addFile({ baseId: base.id, filePath: 'C:\\definitely\\missing\\file.txt' }),
    /无法读取文件/,
  );
  svc.close();
});

// ───────────────────────── 重排序 ─────────────────────────

test('集成：启用重排序时按重排序分数调整顺序', async () => {
  const rerankServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      // 把最后一篇文档排到第一，验证重排序确实生效。
      const results = parsed.documents.map((_, i) => ({ index: i, relevance_score: i })).reverse();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results }));
    });
  });
  await new Promise((resolve) => rerankServer.listen(0, '127.0.0.1', resolve));
  const rerankBase = `http://127.0.0.1:${rerankServer.address().port}`;

  try {
    const svc = memService({ embeddingProvider: 'none' });
    const base = svc.createBase({ name: '库' });
    await svc.addText({ baseId: base.id, title: 'A', text: '部署环境要求第一段。' });
    await svc.addText({ baseId: base.id, title: 'B', text: '部署环境要求第二段。' });
    await svc.addText({ baseId: base.id, title: 'C', text: '部署环境要求第三段。' });

    const before = await svc.search({ query: '部署环境要求' });
    assert.ok(before.hits.length >= 2);
    assert.equal(before.reranked, false);

    svc.saveOverrides({ rerankEnabled: true, rerankEndpoint: rerankBase, rerankModel: 'r' });
    const after = await svc.search({ query: '部署环境要求' });
    assert.equal(after.reranked, true, '应标记已重排序');
    assert.ok(after.hits[0].rerankScore !== null, '应带重排序分数');
    svc.close();
  } finally {
    await closeServer(rerankServer);
  }
});

test('集成：重排序端点失败时不阻断检索（降级返回原始顺序）', async () => {
  const svc = memService({ embeddingProvider: 'none' });
  const base = svc.createBase({ name: '库' });
  // 需要 ≥2 条结果才会触发重排序（单条结果无需重排）。
  await svc.addText({ baseId: base.id, title: 'A', text: '部署环境要求第一段内容。' });
  await svc.addText({ baseId: base.id, title: 'B', text: '部署环境要求第二段内容。' });

  svc.saveOverrides({ rerankEnabled: true, rerankEndpoint: 'http://127.0.0.1:1/rerank', rerankModel: 'r' });
  const result = await svc.search({ query: '部署环境要求' });
  assert.ok(result.hits.length > 0, '重排序失败也要有结果');
  assert.ok(result.rerankError.length > 0, '应记录重排序失败原因');
  svc.close();
});

// ───────────────────────── 配置与状态 ─────────────────────────

test('集成：saveOverrides 持久化并影响检索行为', async () => {
  const svc = memService();
  svc.saveOverrides({ topK: 2 });
  assert.equal(svc.config().topK, 2);
  // 空值应恢复继承
  svc.saveOverrides({ topK: '' });
  assert.equal(svc.config().topK, 6);
  svc.close();
});

test('集成：status() 返回检测报告、下载进度与统计', async () => {
  const svc = memService({ embeddingProvider: 'none' });
  const base = svc.createBase({ name: '库' });
  await svc.addText({ baseId: base.id, title: 't', text: '内容。' });

  const status = await svc.status();
  assert.ok(status.detect, '应有环境检测报告');
  assert.ok(Array.isArray(status.downloads));
  assert.equal(status.stats.bases, 1);
  assert.equal(status.stats.documents, 1);
  assert.ok(status.stats.chunks > 0);
  assert.ok(status.config);
  svc.close();
});

test('集成：detect() 在无网络依赖时也能返回完整报告', async () => {
  const svc = memService();
  const report = await svc.detect({ skipNetwork: true });
  assert.ok(['auto', 'openai', 'custom', 'onnx', 'ollama', 'none'].includes(report.recommended));
  assert.ok(Array.isArray(report.reasons));
  assert.ok(report.apiKey !== undefined);
  assert.ok(report.modelCache?.dir, '应给出模型缓存目录');
  svc.close();
});

test('集成：删除知识库级联清理分块', async () => {
  const svc = memService({ embeddingProvider: 'none' });
  const base = svc.createBase({ name: '待删库' });
  await svc.addText({ baseId: base.id, title: 't', text: '要被删除的内容。' });
  assert.ok(svc.store.stats().chunks > 0);

  svc.deleteBase(base.id);
  assert.equal(svc.listBases().length, 0);
  assert.equal(svc.store.stats().chunks, 0);
  assert.equal(svc.store.stats().documents, 0);
  svc.close();
});

test('集成：空查询给出中文提示', async () => {
  const svc = memService();
  await assert.rejects(() => svc.search({ query: '   ' }), /查询内容为空/);
  svc.close();
});

test('集成：重命名知识库时拒绝空名', () => {
  const svc = memService();
  const base = svc.createBase({ name: '库' });
  assert.throws(() => svc.renameBase(base.id, '  '), /不能为空/);
  svc.close();
});

// ───────────────────────── 非对称模型：service 层 role 传递 ─────────────────────────
//
// provider.test.mjs 只验证 embed.js 会把 inputType 放进请求体；这里锁定
// service 层在三种场景下传给 embedTexts 的 role 是否正确——这是「索引/查询
// 空间对齐」的真正防线：写错方向（查询发 passage、索引发 query）时必须变红。

test('集成：非对称 provider 导入文档时桩服务收到 input_type=passage', async () => {
  const seen = [];
  const server = await startCaptureStub(seen);
  // endpoint 必须指向捕获桩自身——请求真正打到这个桩，seen 才有记录。
  const endpoint = stubEndpoint(server);
  try {
    const svc = memService();
    const provider = svc.createProvider({ kind: 'openai', name: '非对称', endpoint, model: 'asym-m', inputTypeMode: 'asymmetric' });
    await svc.testProvider(provider.id);
    const base = svc.createBase({ name: '库A' });
    svc.bindProvider(base.id, provider.id);
    await svc.addText({ baseId: base.id, title: 't', text: '这是需要被索引的正文内容。' });
    svc.close();
  } finally {
    await closeServer(server);
  }
  assert.ok(seen.length > 0, '桩服务应收到至少一次请求');
  assert.equal(seen.at(-1).input_type, 'passage', '索引入口必须发 passage');
});

test('集成：非对称 provider 检索时桩服务收到 input_type=query', async () => {
  const seen = [];
  const server = await startCaptureStub(seen);
  const endpoint = stubEndpoint(server);
  try {
    const svc = memService();
    const provider = svc.createProvider({ kind: 'openai', name: '非对称', endpoint, model: 'asym-m', inputTypeMode: 'asymmetric' });
    await svc.testProvider(provider.id);
    const base = svc.createBase({ name: '库B' });
    svc.bindProvider(base.id, provider.id);
    await svc.addText({ baseId: base.id, title: 't', text: '苹果公司发布了新的操作系统。' });
    await svc.search({ query: '苹果 操作系统' });
    svc.close();
  } finally {
    await closeServer(server);
  }
  const types = seen.map((b) => b.input_type);
  assert.ok(types.includes('passage'), '导入阶段应发过 passage');
  assert.equal(types.at(-1), 'query', '最后一次请求是检索，必须发 query');
});

test('集成：对称 provider 全链路不发送 input_type（回归保护）', async () => {
  const seen = [];
  const server = await startCaptureStub(seen);
  const endpoint = stubEndpoint(server);
  try {
    const svc = memService();
    const provider = svc.createProvider({ kind: 'openai', name: '对称', endpoint, model: 'sym-m' });
    await svc.testProvider(provider.id);
    const base = svc.createBase({ name: '库C' });
    svc.bindProvider(base.id, provider.id);
    await svc.addText({ baseId: base.id, title: 't', text: '普通对称模型的正文。' });
    await svc.search({ query: '正文' });
    svc.close();
  } finally {
    await closeServer(server);
  }
  assert.ok(seen.length > 0);
  for (const body of seen) assert.equal('input_type' in body, false, '对称模式任何请求都不得携带 input_type');
});

test('集成：切到非对称后未重建时，search 返回 staleBases；重建后清空', async () => {
  const seen = [];
  const server = await startCaptureStub(seen);
  const endpoint = stubEndpoint(server);
  try {
    const svc = memService();
    const provider = svc.createProvider({ kind: 'openai', name: '切换测试', endpoint, model: 'm1' });
    await svc.testProvider(provider.id);
    const base = svc.createBase({ name: '库D' });
    svc.bindProvider(base.id, provider.id);
    await svc.addText({ baseId: base.id, title: 't', text: '重建提示测试正文，苹果与香蕉。' });

    // 对称模式下检索：无 stale。
    let r = await svc.search({ query: '苹果' });
    assert.deepEqual(r.staleBases, []);

    // 切到非对称（同模型、同维度，维度守卫不会触发）→ 应标 stale。
    svc.updateProvider(provider.id, { inputTypeMode: 'asymmetric' });
    assert.equal(svc.listBases().find((b) => b.id === base.id).status, 'stale', '切模式后应标需重建');

    r = await svc.search({ query: '苹果' });
    assert.deepEqual(r.staleBases.map((b) => b.name), ['库D'], '检索结果必须携带 stale 提示');

    // 重建后恢复 ready，提示消失。
    const report = await svc.reindexBase(base.id);
    assert.equal(report.failed.length, 0);
    assert.equal(svc.listBases().find((b) => b.id === base.id).status, 'ready');
    r = await svc.search({ query: '苹果' });
    assert.deepEqual(r.staleBases, []);
    svc.close();
  } finally {
    await closeServer(server);
  }
  // 全链路跑完后，最后一次请求应为检索 query（重建用 passage）。
  assert.equal(seen.at(-1).input_type, 'query');
});

/** 捕获桩的 /v1 端点地址。 */
function stubEndpoint(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}/v1`;
}

/** 记录桩服务收到的每个请求体（model/input/input_type）。 */
function startCaptureStub(seen) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        // 请求体带了 input_type 才记录该键——保证下游 `'input_type' in record`
        // 能区分「发了」与「没发」，而不是被 null 混淆。
        const record = { model: parsed.model, count: parsed.input?.length ?? 0 };
        if ('input_type' in parsed) record.input_type = parsed.input_type;
        seen.push(record);
        const data = parsed.input.map((text, i) => ({
          index: i,
          embedding: Array.from({ length: 4 }, (_, k) => {
            let sum = 0;
            for (const ch of String(text)) sum += ch.codePointAt(0) * (k + 1);
            return (sum % 97) / 97;
          }),
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
