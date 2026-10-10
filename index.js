/**
 * 宿主半：知识库 / RAG 插件的服务端。
 *
 * 注册三类能力：
 *  1. HTTP API（/dsh-destinywind-rag/*）——供设置页「知识库」栏与输入框选择器调用；
 *  2. 模型可见工具 knowledge_search —— description 写清触发条件，让模型自行判断；
 *  3. 系统提示注入 —— 仅列出可用知识库名，并声明当前限定范围。
 *
 * 零配置：首次调用时自动检测环境（Ollama / ONNX / 端点）并创建默认知识库。
 */

import { KnowledgeService } from './lib/service.js';
import os from 'node:os';
import { join } from 'node:path';

export const inject = ['webServer', 'tools', 'systemPrompt'];

const ROUTE_PREFIX = '/dsh-destinywind-rag';
const TOOL_NAME = 'knowledge_search';

/** 惰性单例：首次用到时才建服务，避免启动即扫盘。 */
let service = null;
let logger = { info() {}, warn() {}, error() {} };

function getService(config) {
  if (service === null) {
    service = new KnowledgeService(config ?? {});
  }
  return service;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  const LIMIT = 8 * 1024 * 1024;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) throw new Error('请求体过大（超过 8 MB）');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/** 统一的错误响应：中文消息 + 修复建议。 */
function fail(res, error) {
  const status = error?.name === 'EmbeddingError' || error?.name === 'ParseError' ? 400 : 500;
  return json(res, status, {
    ok: false,
    error: String(error?.message ?? error),
    suggestion: String(error?.suggestion ?? ''),
  });
}

/**
 * 同源校验。
 * 该 API 能重命名/删除知识库、改配置、读任意目录列表，必须防止
 * 浏览器侧恶意页面用 no-cors POST 打进来（fetch no-cors 可以发请求但
 * 读不到响应，对「只写不读」的破坏性操作恰好够用）。
 * 同源判定：无 Origin（非浏览器客户端，如 curl / 模型工具）放行；
 * 有 Origin 时必须与请求的 Host 一致。
 */
function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined || origin === null || String(origin).trim() === '') return true;
  const host = req.headers?.host;
  if (!host) return false;
  try {
    return new URL(String(origin)).host === String(host);
  } catch {
    return false;
  }
}

/**
 * 目录浏览的路径约束：只允许浏览用户可见的数据目录，禁止探测系统目录。
 * 允许：用户主目录、各盘符根下的 Documents/Downloads/Desktop，
 * 以及这些目录的任意子目录。
 */
const FS_BROWSE_ALLOWED_ROOTS = [
  join(os.homedir(), 'Documents'),
  join(os.homedir(), 'Downloads'),
  join(os.homedir(), 'Desktop'),
];
const FS_BROWSE_DRIVE_ROOTS = ['C:\\', 'D:\\', 'E:\\', 'F:\\'];

function isBrowseAllowed(dir) {
  const p = String(dir ?? '').trim();
  if (p === '') return false;
  const lower = p.toLowerCase();
  // 盘符根本身允许（作为浏览起点），但必须落在允许的盘符上。
  if (FS_BROWSE_DRIVE_ROOTS.some((r) => lower === r.toLowerCase())) return true;
  if (FS_BROWSE_ALLOWED_ROOTS.some((r) => lower === r.toLowerCase())) return true;
  // 子目录：必须以某个允许根 + 分隔符开头。
  return FS_BROWSE_ALLOWED_ROOTS.some((r) => lower.startsWith(r.toLowerCase() + '\\'))
    || FS_BROWSE_DRIVE_ROOTS.some((r) => {
      const root = r.toLowerCase();
      // 只放行这些盘符下的「用户数据目录」，系统目录（Windows/Program Files）排除。
      if (!lower.startsWith(root)) return false;
      const rest = lower.slice(root.length);
      if (rest === '') return false;
      const top = rest.split('\\')[0];
      return ['documents', 'downloads', 'desktop', 'users'].includes(top);
    });
}

/**
 * HTTP 路由表。全部返回 { ok: true, ... } 或 { ok: false, error, suggestion }。
 */
function makeHandler(getConfig) {
  return async (req, res) => {
    // 同源校验：跨源写入请求一律拒绝。
    if (!sameOrigin(req)) {
      return json(res, 403, { ok: false, error: '跨源请求被拒绝', suggestion: '请从 DSH 界面内发起操作。' });
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      const svc = getService(getConfig());

      // ── 状态与环境检测 ──
      if (method === 'GET' && path === '/status') {
        return json(res, 200, { ok: true, ...(await svc.status()) });
      }
      if (method === 'POST' && path === '/detect') {
        const report = await svc.detect();
        return json(res, 200, { ok: true, detect: report });
      }
      if (method === 'POST' && path === '/ensure-default') {
        const r = await svc.ensureDefault();
        return json(res, 200, { ok: true, ...r });
      }

      // ── 配置 ──
      if (method === 'GET' && path === '/config') {
        return json(res, 200, { ok: true, config: svc.config() });
      }
      if (method === 'POST' && path === '/config') {
        const body = await readJsonBody(req);
        return json(res, 200, { ok: true, config: svc.saveOverrides(body?.overrides ?? body) });
      }

      // ── 知识库 ──
      if (method === 'GET' && path === '/bases') {
        return json(res, 200, { ok: true, bases: svc.listBases() });
      }
      if (method === 'POST' && path === '/bases') {
        const body = await readJsonBody(req);
        return json(res, 200, { ok: true, base: svc.createBase(body) });
      }
      const baseMatch = /^\/bases\/([^/]+)$/.exec(path);
      if (baseMatch) {
        const id = decodeURIComponent(baseMatch[1]);
        if (method === 'GET') {
          const bases = svc.listBases();
          const base = bases.find((b) => b.id === id);
          if (!base) return json(res, 404, { ok: false, error: '知识库不存在' });
          return json(res, 200, { ok: true, base });
        }
        if (method === 'PATCH' || method === 'POST') {
          const body = await readJsonBody(req);
          if (body?.name !== undefined) {
            return json(res, 200, { ok: true, base: svc.renameBase(id, body.name) });
          }
          return json(res, 400, { ok: false, error: '没有可更新的字段' });
        }
        if (method === 'DELETE') {
          return json(res, 200, { ok: true, ...svc.deleteBase(id) });
        }
      }

      // ── 文档 ──
      if (method === 'GET' && path === '/documents') {
        const baseId = url.searchParams.get('baseId') ?? '';
        return json(res, 200, { ok: true, documents: svc.listDocuments(baseId) });
      }
      if (method === 'POST' && path === '/documents') {
        const body = await readJsonBody(req);
        if (body?.filePath) return json(res, 200, { ok: true, ...(await svc.addFile(body)) });
        if (body?.dirPath) return json(res, 200, { ok: true, ...(await svc.addDirectory(body)) });
        return json(res, 200, { ok: true, ...(await svc.addText(body)) });
      }
      const docMatch = /^\/documents\/([^/]+)$/.exec(path);
      if (docMatch && method === 'DELETE') {
        return json(res, 200, { ok: true, ...svc.deleteDocument(decodeURIComponent(docMatch[1])) });
      }

      // ── provider ──
      if (method === 'GET' && path === '/providers') {
        return json(res, 200, { ok: true, providers: svc.listProviders(), bindings: svc.listBindings() });
      }
      if (method === 'POST' && path === '/providers') {
        const body = await readJsonBody(req);
        return json(res, 200, { ok: true, provider: svc.createProvider(body) });
      }
      const providerMatch = /^\/providers\/([^/]+)$/.exec(path);
      if (providerMatch) {
        const id = decodeURIComponent(providerMatch[1]);
        if (method === 'PATCH' || method === 'POST') {
          const body = await readJsonBody(req);
          return json(res, 200, { ok: true, provider: svc.updateProvider(id, body) });
        }
        if (method === 'DELETE') {
          return json(res, 200, { ok: true, ...svc.deleteProvider(id) });
        }
      }
      const testMatch = /^\/providers\/([^/]+)\/test$/.exec(path);
      if (testMatch && (method === 'POST' || method === 'GET')) {
        const result = await svc.testProvider(decodeURIComponent(testMatch[1]));
        return json(res, 200, { ok: true, result });
      }

      // ── 绑定与维度 ──
      if (method === 'POST' && path === '/bindings') {
        const body = await readJsonBody(req);
        const r = svc.bindProvider(String(body?.baseId ?? ''), String(body?.providerId ?? ''), String(body?.role ?? 'embedding'));
        return json(res, 200, { ok: true, ...r });
      }
      if (method === 'GET' && path === '/bindings') {
        return json(res, 200, { ok: true, bindings: svc.listBindings() });
      }
      const dimMatch = /^\/bases\/([^/]+)\/dimension$/.exec(path);
      if (dimMatch && method === 'GET') {
        return json(res, 200, { ok: true, dimension: svc.checkBaseDimension(decodeURIComponent(dimMatch[1])) });
      }

      // ── 重建索引 ──
      const reindexMatch = /^\/bases\/([^/]+)\/reindex$/.exec(path);
      if (reindexMatch && method === 'POST') {
        const baseId = decodeURIComponent(reindexMatch[1]);
        const report = await svc.reindexBase(baseId);
        return json(res, 200, { ok: true, report });
      }

      // ── 检索 ──
      if (method === 'POST' && path === '/search') {
        const body = await readJsonBody(req);
        const result = await svc.search(body);
        return json(res, 200, { ok: true, ...result });
      }

      // ── 本地模型下载 ──
      if (method === 'POST' && path === '/models/download') {
        const body = await readJsonBody(req);
        return json(res, 200, { ok: true, ...svc.startModelDownload(body?.model) });
      }
      if (method === 'POST' && path === '/models/cancel') {
        const body = await readJsonBody(req);
        return json(res, 200, { ok: true, ...svc.cancelModelDownload(body?.model) });
      }

      // ── 目录浏览（「添加文件夹」的辅助选择器）──
      if (method === 'GET' && path === '/fs/list') {
        const dir = url.searchParams.get('path') ?? '';
        if (dir.trim() === '') return json(res, 400, { ok: false, error: '请提供目录路径' });
        // 路径约束：只允许浏览用户数据目录，禁止探测系统目录。
        if (!isBrowseAllowed(dir)) {
          return json(res, 403, {
            ok: false,
            error: '该路径不在允许浏览的范围内',
            suggestion: '仅支持浏览用户主目录下的 Documents / Downloads / Desktop 及其子目录。',
          });
        }
        const { readdir } = await import('node:fs/promises');
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          const dirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .slice(0, 200)
            .map((e) => ({ name: e.name, path: `${dir.replace(/[\\/]+$/, '')}\\${e.name}` }));
          return json(res, 200, { ok: true, entries: dirs });
        } catch (error) {
          return json(res, 400, {
            ok: false,
            error: `无法读取目录：${String(error?.message ?? error)}`,
            suggestion: '请确认路径存在且当前用户有读取权限。',
          });
        }
      }

      // ── 检索范围（输入框旁选择器同步）──
      if (method === 'POST' && path === '/scope') {
        const body = await readJsonBody(req);
        const scope = String(body?.scope ?? 'auto');
        svc.store.setSetting('activeScope', { scope, baseId: body?.baseId ?? null, updatedAt: Date.now() });
        return json(res, 200, { ok: true, scope });
      }
      if (method === 'GET' && path === '/scope') {
        const scope = svc.store.getSetting('activeScope', { scope: 'auto', baseId: null });
        return json(res, 200, { ok: true, ...scope });
      }

      return json(res, 404, { ok: false, error: '未知接口' });
    } catch (error) {
      logger.warn?.(`knowledge: 请求失败 ${method} ${path} — ${String(error?.message ?? error)}`);
      return fail(res, error);
    }
  };
}

/** 工具返回给模型的文本（含来源，便于回答时引用）。 */
function renderToolResult(result) {
  if (result.hits.length === 0) {
    return result.message ?? '未在知识库中找到相关内容。可尝试更换关键词，或确认目标知识库已完成索引。';
  }
  const lines = [`检索到 ${result.hits.length} 条相关内容（耗时 ${result.elapsedMs} ms${result.reranked ? '，已重排序' : ''}）：`, ''];
  result.hits.forEach((hit, i) => {
    const locator = hit.source.locator ? ` · ${hit.source.locator}` : '';
    const where = hit.source.path || hit.documentTitle || '未知来源';
    lines.push(`[${i + 1}] 相似度 ${hit.score.toFixed(3)} · 来源：${where}${locator}`);
    lines.push(hit.text);
    lines.push('');
  });
  lines.push('引用以上内容时，请标注来源文件与页码/行号，便于用户核对。');
  return lines.join('\n');
}

/** 构造 knowledge_search 的工具定义。 */
function buildSearchTool(svc) {
  return {
    name: TOOL_NAME,
    description: [
      '在用户的知识库中做语义 + 关键词混合检索，返回最相关的文档片段及其来源（文件路径、页码/行号）。',
      '',
      '触发条件（命中任意一条就应当调用）：',
      '- 用户提问涉及已导入知识库的文档、内部资料、手册、规范、论文或专有知识；',
      '- 用户的问题需要引用具体文档内容才能准确回答，或需要给出可核对的出处；',
      '- 用户明确提到「知识库」「文档」「资料」「手册」等，或使用 /kb 命令。',
      '',
      '不必调用的情形：',
      '- 纯通用常识、闲聊、代码语法等与用户私有文档无关的问题；',
      '- 用户已把全部必要内容直接粘贴在对话里。',
      '',
      '返回结果含相似度分数与来源定位；回答时请据此标注出处。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '检索问题或关键词。' },
        baseId: { type: 'string', description: '可选：限定到某个知识库 id；省略则检索全部知识库。' },
        topK: { type: 'number', description: '可选：返回条数，默认取插件配置。' },
        mode: {
          type: 'string',
          enum: ['auto', 'hybrid', 'vector', 'lexical'],
          description: '可选：检索模式。auto 会按是否有可用向量自动选择。',
        },
      },
      required: ['query'],
    },
    async execute(args) {
      // 输入框旁的「知识库范围」选择器：模型未显式指定 baseId 时遵循它。
      // auto = 不限定（检索全部库，由模型自行判断是否需要检索）；
      // all  = 明确限定为全部知识库；具体 id = 限定该库。
      let baseId = args?.baseId;
      if (baseId === undefined || baseId === null || baseId === '') {
        const picker = svc.store.getSetting('activeScope', { scope: 'auto', baseId: null });
        if (picker?.scope === 'all') baseId = 'all';
        else if (picker?.scope === 'base' && picker?.baseId) baseId = String(picker.baseId);
        // scope === 'auto' → 保持 undefined，即检索全部知识库。
      }
      const result = await svc.search({
        query: String(args?.query ?? ''),
        baseId,
        topK: args?.topK,
        mode: args?.mode,
      });
      return {
        content: renderToolResult(result),
        // 结构化数据供 UI 渲染来源卡片。
        data: { hits: result.hits, elapsedMs: result.elapsedMs, reranked: result.reranked },
      };
    },
  };
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文（已注入 webServer / tools / systemPrompt）
 * @param {object} config 插件 Config
 */
export function apply(ctx, config = {}) {
  const getConfig = () => config;
  const svc = getService(config);

  try {
    const candidate = typeof ctx?.get === 'function' ? ctx.get('logger') : undefined;
    if (candidate) logger = candidate;
  } catch {
    /* 保持空实现 */
  }

  // 1) HTTP API
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: makeHandler(getConfig) }),
    'dsh-destinywind-rag: routes',
  );

  // 2) 模型可见工具
  if (typeof ctx?.tools?.register === 'function') {
    ctx.tools.register(buildSearchTool(svc));
    logger.info?.('dsh-destinywind-rag: 已注册工具 knowledge_search');
  } else {
    logger.warn?.('dsh-destinywind-rag: tools 服务不可用，未注册 knowledge_search');
  }

  // 3) 系统提示：只列知识库名，避免把文档内容塞进提示词。
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'plugin:destinywind-rag',
      order: 220,
      text: () => {
        try {
          const cfg = svc.config();
          if (cfg.injectUsagePrompt === false) return '';
          const bases = svc.listBases();
          if (bases.length === 0) return '';
          const names = bases.slice(0, 12).map((b) => `${b.name}（${b.docCount} 篇）`).join('、');
          return [
            '## 知识库',
            `可用知识库：${names}${bases.length > 12 ? ` 等 ${bases.length} 个` : ''}。`,
            '当问题涉及这些知识库中的文档、内部资料或专有知识时，调用 knowledge_search 检索；回答时标注来源文件与页码/行号。',
          ].join('\n');
        } catch {
          return '';
        }
      },
    }),
    'dsh-destinywind-rag: prompt section',
  );

  // 4) 启动时静默检测（不阻塞、失败不影响启动）。
  void svc.detect().catch((error) => {
    logger.warn?.(`dsh-destinywind-rag: 环境检测失败 — ${String(error?.message ?? error)}`);
  });

  // 5) 卸载回调：DSH 停用/热重载插件时释放 SQLite 连接与本地模型内存。
  //    缺了它，每次热重载都会泄漏一个数据库句柄（Windows 下文件被占用，删除 profile 会失败）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        svc.close();
        logger.info?.('dsh-destinywind-rag: 已卸载（数据库连接与模型内存已释放）');
      } catch (error) {
        logger.warn?.(`dsh-destinywind-rag: 卸载清理失败 — ${String(error?.message ?? error)}`);
      }
    }, 'dsh-destinywind-rag: dispose');
  }

  logger.info?.('dsh-destinywind-rag: 已挂载（知识库 / RAG，混合检索）');
}

export { TOOL_NAME, ROUTE_PREFIX };
