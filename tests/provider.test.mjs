/**
 * 单元测试：配置解析、provider 工厂、维度校验、embedding 分发与错误处理。
 * 远程调用部分用本地 HTTP 桩服务器验证，不访问外网。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolveConfig, resolveConfigForBase, resolveApiKey, DEFAULT_ONNX_MODEL } from '../lib/config.js';
import {
  embedTexts,
  batch,
  normalizeEndpoint,
  checkDimension,
  normalizeVector,
  EmbeddingError,
  probeRemote,
  probeOllama,
} from '../lib/embed.js';

// ───────────────────────── 配置 ─────────────────────────

test('resolveConfig：缺省值完整且类型正确', () => {
  const c = resolveConfig({});
  assert.equal(c.embeddingProvider, 'auto');
  assert.equal(c.chunkSize, 800);
  assert.equal(c.chunkOverlap, 100);
  assert.equal(c.topK, 6);
  assert.equal(c.searchMode, 'auto');
  assert.equal(c.rrfVectorWeight, 1);
  assert.equal(typeof c.autoRetrieve, 'boolean');
});

test('resolveConfig：越界值被钳制而非抛错', () => {
  const c = resolveConfig({ chunkSize: -5, topK: 999, rrfVectorWeight: 100, similarityThreshold: 5 });
  assert.ok(c.chunkSize >= 64);
  assert.ok(c.topK <= 50);
  assert.ok(c.rrfVectorWeight <= 5);
  assert.ok(c.similarityThreshold <= 1);
});

test('resolveConfig：非数值输入回退默认值', () => {
  const c = resolveConfig({ chunkSize: 'abc', topK: null, chunkOverlap: {} });
  assert.equal(c.chunkSize, 800);
  assert.equal(c.topK, 6);
});

test('resolveConfig：chunkOverlap 不会大于等于 chunkSize', () => {
  const c = resolveConfig({ chunkSize: 100, chunkOverlap: 500 });
  assert.ok(c.chunkOverlap < c.chunkSize);
});

test('resolveConfig：运行时覆盖优先于插件 Config', () => {
  const c = resolveConfig({ topK: 3 }, { topK: 10 });
  assert.equal(c.topK, 10);
});

test('resolveConfig：空字符串覆盖视为未设置，继续继承', () => {
  const c = resolveConfig({ topK: 3 }, { topK: '' });
  assert.equal(c.topK, 3);
});

test('resolveConfigForBase：每库覆盖生效，空字段继承全局', () => {
  const global = resolveConfig({ topK: 6, chunkSize: 800 });
  const merged = resolveConfigForBase(global, { topK: 12, chunkSize: '' });
  assert.equal(merged.topK, 12);
  assert.equal(merged.chunkSize, 800);
});

test('resolveConfigForBase：无每库配置时返回全局副本', () => {
  const global = resolveConfig({ topK: 7 });
  const merged = resolveConfigForBase(global, undefined);
  assert.equal(merged.topK, 7);
  assert.notEqual(merged, global, '应返回副本，避免调用方改动污染全局');
});

test('resolveConfigForBase：每库覆盖同样受边界钳制', () => {
  const global = resolveConfig({});
  const merged = resolveConfigForBase(global, { topK: 9999 });
  assert.ok(merged.topK <= 50);
});

test('resolveApiKey：环境变量兜底', () => {
  const prev = process.env.KNOWLEDGE_API_KEY;
  process.env.KNOWLEDGE_API_KEY = 'env-key';
  try {
    assert.equal(resolveApiKey({ embeddingApiKey: '' }), 'env-key');
    assert.equal(resolveApiKey({ embeddingApiKey: 'direct' }), 'direct', '直接配置优先于环境变量');
  } finally {
    if (prev === undefined) delete process.env.KNOWLEDGE_API_KEY;
    else process.env.KNOWLEDGE_API_KEY = prev;
  }
});

// ───────────────────────── 维度校验 ─────────────────────────

test('checkDimension：一致时 status=ok', () => {
  const r = checkDimension(1024, 1024);
  assert.equal(r.status, 'ok');
  assert.equal(r.modelDim, 1024);
});

test('checkDimension：不一致时 status=mismatch 且提示需重建', () => {
  const r = checkDimension(1536, 1024);
  assert.equal(r.status, 'mismatch');
  assert.match(r.message, /需重建/);
});

test('checkDimension：模型维度未知时 status=unknown', () => {
  const r = checkDimension(0, 1024);
  assert.equal(r.status, 'unknown');
  assert.match(r.message, /测试连接/);
});

test('checkDimension：尚未建索引时视为 ok（将按新维度建立）', () => {
  const r = checkDimension(768, 0);
  assert.equal(r.status, 'ok');
  assert.match(r.message, /768/);
});

// ───────────────────────── 工具函数 ─────────────────────────

test('batch：正确切批', () => {
  assert.deepEqual(batch([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batch([], 3), []);
  assert.deepEqual(batch([1], 0), [[1]], '非法批次大小回退为 1');
});

test('normalizeEndpoint：去掉尾部斜杠', () => {
  assert.equal(normalizeEndpoint('https://api.test/v1/'), 'https://api.test/v1');
  assert.equal(normalizeEndpoint('https://api.test/v1'), 'https://api.test/v1');
  assert.equal(normalizeEndpoint(''), '');
});

test('normalizeVector：L2 归一化后模长为 1', () => {
  const v = normalizeVector([3, 4]);
  const norm = Math.sqrt(v[0] ** 2 + v[1] ** 2);
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test('normalizeVector：零向量不产生 NaN', () => {
  const v = normalizeVector([0, 0]);
  assert.deepEqual(v, [0, 0]);
});

// ───────────────────────── embedding 分发 ─────────────────────────

test('embedTexts：空输入直接返回空数组', async () => {
  assert.deepEqual(await embedTexts({ kind: 'openai' }, []), []);
});

test('embedTexts：provider=none 抛中文错误并给建议', async () => {
  await assert.rejects(
    () => embedTexts({ kind: 'none' }, ['x']),
    (err) => {
      assert.ok(err instanceof EmbeddingError);
      assert.match(err.message, /未配置向量引擎|纯关键词/);
      assert.ok(err.suggestion.length > 0);
      return true;
    },
  );
});

test('embedTexts：未知 kind 抛错', async () => {
  await assert.rejects(() => embedTexts({ kind: 'nope' }, ['x']), /未知的向量引擎类型/);
});

test('embedTexts：openai 缺端点时报中文错误', async () => {
  await assert.rejects(
    () => embedTexts({ kind: 'custom', endpoint: '', model: 'm' }, ['x']),
    /端点地址为空/,
  );
});

test('embedTexts：缺模型名时报中文错误', async () => {
  await assert.rejects(
    () => embedTexts({ kind: 'openai', endpoint: 'http://127.0.0.1:1/v1', model: '' }, ['x']),
    /模型名为空/,
  );
});

test('embedTexts：onnx 无运行时注入时给出安装建议', async () => {
  await assert.rejects(
    () => embedTexts({ kind: 'onnx', model: DEFAULT_ONNX_MODEL }, ['x']),
    (err) => {
      assert.match(err.message, /本地 ONNX 运行时不可用/);
      assert.match(err.suggestion, /transformers/);
      return true;
    },
  );
});

// ───────────────────────── 本地桩服务器：远程链路 ─────────────────────────

/** 起一个 OpenAI 兼容 /embeddings 桩服务。 */
async function withStubServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await closeServer(server);
  }
}

/**
 * 关闭桩服务器。
 * Node 的 fetch（undici）默认保持 keep-alive 连接，只调 close() 会一直等待
 * 连接释放，导致测试挂起；必须先 closeAllConnections() 强制断开。
 */
export async function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test('embedTexts：OpenAI 兼容链路返回向量（维度正确）', async () => {
  await withStubServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const data = parsed.input.map((_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3, 0.4] }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  }, async (base) => {
    const vectors = await embedTexts({ kind: 'openai', endpoint: base, model: 'test-model', apiKey: 'k' }, ['甲', '乙']);
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0].length, 4);
  });
});

test('embedTexts：端点乱序返回时按 index 重新排序', async () => {
  await withStubServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      // 故意倒序返回
      const data = parsed.input.map((_, i) => ({ index: i, embedding: [i, i] })).reverse();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  }, async (base) => {
    const vectors = await embedTexts({ kind: 'openai', endpoint: base, model: 'm' }, ['a', 'b', 'c']);
    assert.deepEqual(vectors, [[0, 0], [1, 1], [2, 2]], '顺序应与输入一致');
  });
});

test('embedTexts：HTTP 401 给出 API Key 修复建议', async () => {
  await withStubServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }, async (base) => {
    await assert.rejects(
      () => embedTexts({ kind: 'openai', endpoint: base, model: 'm', apiKey: 'bad' }, ['x']),
      (err) => {
        assert.match(err.message, /HTTP 401/);
        assert.match(err.suggestion, /API Key/);
        return true;
      },
    );
  });
});

test('embedTexts：HTTP 404 提示端点路径需含 /v1', async () => {
  await withStubServer((req, res) => {
    res.writeHead(404);
    res.end('not found');
  }, async (base) => {
    await assert.rejects(
      () => embedTexts({ kind: 'openai', endpoint: base, model: 'm' }, ['x']),
      (err) => { assert.match(err.suggestion, /\/v1/); return true; },
    );
  });
});

test('embedTexts：返回条数不匹配时报错', async () => {
  await withStubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
  }, async (base) => {
    await assert.rejects(
      () => embedTexts({ kind: 'openai', endpoint: base, model: 'm' }, ['a', 'b']),
      /条数与请求不一致/,
    );
  });
});

test('embedTexts：返回非法 JSON 时报错', async () => {
  await withStubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('not-json');
  }, async (base) => {
    await assert.rejects(
      () => embedTexts({ kind: 'openai', endpoint: base, model: 'm' }, ['a']),
      /不是合法 JSON/,
    );
  });
});

test('embedTexts：超过批次大小时自动切批', async () => {
  let calls = 0;
  await withStubServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls += 1;
      const parsed = JSON.parse(body);
      const data = parsed.input.map((_, i) => ({ index: i, embedding: [1, 0] }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  }, async (base) => {
    const vectors = await embedTexts({ kind: 'openai', endpoint: base, model: 'm' }, ['a', 'b', 'c', 'd', 'e'], { batchSize: 2 });
    assert.equal(vectors.length, 5);
    assert.equal(calls, 3, '5 条 / 每批 2 条 = 3 次请求');
  });
});

test('probeRemote：成功时返回维度与延迟', async () => {
  await withStubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [0, 0, 0, 0, 0] }] }));
  }, async (base) => {
    const r = await probeRemote({ kind: 'openai', endpoint: base, model: 'm' });
    assert.equal(r.ok, true);
    assert.equal(r.dim, 5);
    assert.ok(r.latencyMs >= 0);
  });
});

test('probeRemote：失败时返回中文错误与建议，不抛异常', async () => {
  const r = await probeRemote({ kind: 'openai', endpoint: 'http://127.0.0.1:1/v1', model: 'm' }, { timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});

test('probeOllama：服务不可达时返回中文原因与启动建议', async () => {
  const r = await probeOllama('http://127.0.0.1:1', { timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.match(r.error, /无法连接 Ollama/);
  assert.match(r.suggestion, /Ollama/);
  assert.match(r.suggestion, /启动|安装/);
});

test('probeOllama：服务在线时返回模型列表', async () => {
  await withStubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'bge-m3' }, { name: 'llama3:latest' }] }));
  }, async (base) => {
    const r = await probeOllama(base);
    assert.equal(r.ok, true);
    assert.deepEqual(r.models, ['bge-m3', 'llama3:latest']);
  });
});

test('embedTexts：Ollama 缺模型时给出 ollama pull 建议', async () => {
  await withStubServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'model not found' }));
  }, async (base) => {
    await assert.rejects(
      () => embedTexts({ kind: 'ollama', endpoint: base, model: 'bge-m3' }, ['x']),
      (err) => {
        assert.match(err.message, /找不到模型/);
        assert.match(err.suggestion, /ollama pull bge-m3/);
        return true;
      },
    );
  });
});

test('embedTexts：Ollama 链路成功返回向量', async () => {
  await withStubServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embedding: new Array(8).fill(parsed.prompt.length) }));
    });
  }, async (base) => {
    const vectors = await embedTexts({ kind: 'ollama', endpoint: base, model: 'bge-m3' }, ['ab', 'abcd']);
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0].length, 8);
    assert.equal(vectors[0][0], 2, '向量值应随 prompt 长度变化，验证确实逐条发送');
    assert.equal(vectors[1][0], 4);
  });
});
