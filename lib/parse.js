/**
 * 文档解析：把支持的格式统一转成纯文本 + 页码信息。
 *
 * 支持格式：PDF、DOCX、PPTX、Markdown、TXT（以及无扩展名的纯文本）。
 *
 * 依赖策略（关键取舍）：
 *  - 解析库全部按需动态 import，缺失时给出中文安装提示而不是启动即崩；
 *  - PDF 优先用 pdfjs-dist（纯 JS、跨平台），退回 pdf-parse；
 *  - DOCX 用 mammoth，PPTX 用 jszip 直接读 XML（避免再引入一个解析器）；
 *  - Markdown / TXT 直接读文本，Markdown 仅做轻量清洗（保留可读性，不转 HTML）。
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** 支持的扩展名。 */
export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.pptx', '.md', '.markdown', '.txt', '.text', '.log', '.json', '.csv', '.html', '.htm'];

export class ParseError extends Error {
  constructor(message, suggestion) {
    super(message);
    this.name = 'ParseError';
    this.suggestion = suggestion ?? '';
  }
}

/** 判断文件是否受支持。 */
export function isSupported(filePath) {
  return SUPPORTED_EXTENSIONS.includes(extname(String(filePath ?? '')).toLowerCase());
}

/**
 * 解析单个文件为 { text, pageCount, mimeType, title }。
 * @param {string} filePath 绝对路径
 */
export async function parseFile(filePath) {
  const p = String(filePath ?? '');
  const ext = extname(p).toLowerCase();
  let buffer;
  try {
    buffer = await readFile(p);
  } catch (error) {
    throw new ParseError(`无法读取文件：${p}`, `请确认文件存在且可读（${String(error?.message ?? error)}）。`);
  }

  if (ext === '.pdf') return parsePdf(buffer, p);
  if (ext === '.docx') return parseDocx(buffer, p);
  if (ext === '.pptx') return parsePptx(buffer, p);
  if (ext === '.html' || ext === '.htm') return parseHtml(buffer, p);
  // Markdown / TXT / 其它纯文本
  return parsePlainText(buffer, p, ext);
}

/** HTML：剥脚本样式与标签、解实体——零依赖，保正文可检索。 */
function parseHtml(buffer, filePath) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    text,
    pageCount: 0,
    mimeType: 'text/html',
    title: baseName(filePath),
  };
}

/** 纯文本：按 UTF-8 解码，Markdown 仅去掉代码围栏标记以提升可检索性。 */
function parsePlainText(buffer, filePath, ext) {
  let text = buffer.toString('utf8');
  // 去掉 UTF-8 BOM，否则首个词条会带上不可见字符导致检索不中。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (ext === '.md' || ext === '.markdown') {
    text = text
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ''))
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  }
  return {
    text,
    pageCount: 0,
    mimeType: ext === '.md' || ext === '.markdown' ? 'text/markdown' : 'text/plain',
    title: baseName(filePath),
  };
}

/** PDF：优先 pdfjs-dist，按页拼接并在页间插入分页标记，便于回溯页码。 */
async function parsePdf(buffer, filePath) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    try {
      pdfjs = await import('pdfjs-dist');
    } catch {
      return parsePdfFallback(buffer, filePath);
    }
  }

  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items.map((it) => String(it?.str ?? '')).join(' ');
      pages.push(`【第 ${i} 页】\n${line}`);
    }
    return {
      text: pages.join('\n\n'),
      pageCount: doc.numPages,
      mimeType: 'application/pdf',
      title: baseName(filePath),
    };
  } catch (error) {
    return parsePdfFallback(buffer, filePath, error);
  }
}

/** PDF 兜底：pdf-parse。 */
async function parsePdfFallback(buffer, filePath, cause) {
  try {
    const mod = await import('pdf-parse');
    const parse = mod.default ?? mod;
    const result = await parse(buffer);
    return {
      text: String(result?.text ?? ''),
      pageCount: Number(result?.numpages ?? 0) || 0,
      mimeType: 'application/pdf',
      title: baseName(filePath),
    };
  } catch {
    throw new ParseError(
      `PDF 解析失败：${baseName(filePath)}`,
      `请安装解析依赖后重试：npm i pdfjs-dist（或 pdf-parse）。${cause ? `原始错误：${String(cause?.message ?? cause)}` : ''}`,
    );
  }
}

/** DOCX：mammoth 转纯文本。 */
async function parseDocx(buffer, filePath) {
  let mammoth;
  try {
    const mod = await import('mammoth');
    mammoth = mod.default ?? mod;
  } catch {
    throw new ParseError(
      `无法解析 DOCX：${baseName(filePath)}`,
      '请安装解析依赖：npm i mammoth。',
    );
  }
  try {
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: String(result?.value ?? ''),
      pageCount: 0,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      title: baseName(filePath),
    };
  } catch (error) {
    throw new ParseError(`DOCX 解析失败：${baseName(filePath)}`, String(error?.message ?? error));
  }
}

/** PPTX：用 jszip 读 slide XML，提取 <a:t> 文本节点。 */
async function parsePptx(buffer, filePath) {
  let JSZip;
  try {
    const mod = await import('jszip');
    JSZip = mod.default ?? mod;
  } catch {
    throw new ParseError(
      `无法解析 PPTX：${baseName(filePath)}`,
      '请安装解析依赖：npm i jszip。',
    );
  }
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => slideNumber(a) - slideNumber(b));

    const slides = [];
    for (const name of slideNames) {
      const xml = await zip.files[name].async('string');
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXml(m[1]));
      if (texts.length > 0) {
        slides.push(`【第 ${slideNumber(name)} 页】\n${texts.join('\n')}`);
      }
    }
    return {
      text: slides.join('\n\n'),
      pageCount: slideNames.length,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      title: baseName(filePath),
    };
  } catch (error) {
    throw new ParseError(`PPTX 解析失败：${baseName(filePath)}`, String(error?.message ?? error));
  }
}

function slideNumber(name) {
  const m = /slide(\d+)\.xml$/.exec(String(name));
  return m ? Number(m[1]) : 0;
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function baseName(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

/**
 * 按页标记把整篇文本切成「页 → 文本」的映射，用于给分块回填页码。
 * @returns {Array<{pageNo:number, start:number, end:number}>}
 */
export function locatePages(text) {
  const source = String(text ?? '');
  const re = /【第 (\d+) 页】/g;
  const marks = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    marks.push({ pageNo: Number(m[1]), start: m.index });
  }
  return marks.map((mark, i) => ({
    pageNo: mark.pageNo,
    start: mark.start,
    end: i + 1 < marks.length ? marks[i + 1].start : source.length,
  }));
}

/** 由字符偏移反查页码（无页标记时返回 0）。 */
export function pageAt(pageMarks, charOffset) {
  const offset = Number(charOffset) || 0;
  for (const mark of pageMarks) {
    if (offset >= mark.start && offset < mark.end) return mark.pageNo;
  }
  return 0;
}
