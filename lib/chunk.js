/**
 * 文本分块：按分隔符优先切分，超长段落按句子边界二次切分，最后按字符预算合并。
 *
 * 设计取舍（沿用 dsh-knowledge 的 smartChunk 思路，去掉语义分块以保持零依赖）：
 *  - 优先在段落边界（默认 \n\n）切，保住语义完整性；
 *  - 段落本身超预算时，退到句子边界（中英文句号/问号/换行）再切；
 *  - 相邻小块合并到接近 chunkSize，避免碎片化；
 *  - overlap 按字符回退重叠，保证跨块语义连续。
 */

/** 句子边界：中英文句末标点 + 换行。保留标点在句尾。 */
const SENTENCE_BOUNDARY = /([。！？!?；;]|\n)/;

/** 按段落切分，保留非空段落。 */
export function splitParagraphs(text, separator = '\n\n') {
  const sep = separator && separator !== '' ? separator : '\n\n';
  return String(text ?? '')
    .split(sep)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** 把超长段落按句子边界切成不超过 limit 的片段。 */
export function splitSentences(text, limit) {
  const out = [];
  let buffer = '';
  const parts = String(text ?? '').split(SENTENCE_BOUNDARY);
  // split 带捕获组时，分隔符会作为独立元素出现，需要重新拼回句尾。
  for (let i = 0; i < parts.length; i += 1) {
    const piece = parts[i];
    if (piece === undefined) continue;
    const isBoundary = i % 2 === 1;
    const segment = isBoundary ? piece : piece;
    if (segment === '') continue;

    if (buffer.length + segment.length <= limit) {
      buffer += segment;
      continue;
    }
    if (buffer !== '') {
      out.push(buffer);
      buffer = '';
    }
    if (segment.length <= limit) {
      buffer = segment;
      continue;
    }
    // 单句仍超长：硬切，保证不产生超预算块。
    for (let start = 0; start < segment.length; start += limit) {
      out.push(segment.slice(start, start + limit));
    }
  }
  if (buffer !== '') out.push(buffer);
  return out.filter((s) => s.trim() !== '');
}

/**
 * 主分块入口。
 * @param {string} text 原始文本
 * @param {{chunkSize:number, chunkOverlap:number, separator?:string, smartChunk?:boolean}} options
 * @returns {Array<{index:number, text:string, charStart:number, charEnd:number}>}
 */
export function chunkText(text, options = {}) {
  const source = String(text ?? '');
  if (source.trim() === '') return [];

  const chunkSize = Number.isFinite(options.chunkSize) && options.chunkSize > 0
    ? Math.trunc(options.chunkSize)
    : 800;
  const overlap = Number.isFinite(options.chunkOverlap) && options.chunkOverlap >= 0
    ? Math.min(Math.trunc(options.chunkOverlap), Math.max(0, chunkSize - 1))
    : 0;
  const separator = options.separator ?? '\n\n';
  const smart = options.smartChunk !== false;

  // 1) 先切成不超过 chunkSize 的「单元」。
  const units = [];
  for (const paragraph of splitParagraphs(source, separator)) {
    if (paragraph.length <= chunkSize) {
      units.push(paragraph);
      continue;
    }
    if (!smart) {
      for (let start = 0; start < paragraph.length; start += chunkSize) {
        units.push(paragraph.slice(start, start + chunkSize));
      }
      continue;
    }
    for (const sentence of splitSentences(paragraph, chunkSize)) units.push(sentence);
  }
  if (units.length === 0) return [];

  // 2) 合并相邻单元到接近 chunkSize。
  const merged = [];
  let buffer = '';
  for (const unit of units) {
    if (buffer === '') {
      buffer = unit;
      continue;
    }
    if (buffer.length + 1 + unit.length <= chunkSize) {
      buffer = `${buffer}\n${unit}`;
      continue;
    }
    merged.push(buffer);
    buffer = unit;
  }
  if (buffer !== '') merged.push(buffer);

  // 3) 加重叠并定位原文偏移，便于结果回溯到具体行号。
  const chunks = [];
  let cursor = 0;
  for (let i = 0; i < merged.length; i += 1) {
    let body = merged[i];
    if (i > 0 && overlap > 0) {
      const prev = merged[i - 1];
      const tail = prev.slice(Math.max(0, prev.length - overlap));
      body = `${tail}${body}`;
    }
    // 在原文中定位（从 cursor 起找，避免重复片段定位到更早的相同文本）。
    let charStart = source.indexOf(body, cursor);
    if (charStart < 0) charStart = source.indexOf(body);
    if (charStart < 0) charStart = cursor;
    const charEnd = charStart + body.length;
    cursor = Math.max(cursor, charStart);
    chunks.push({
      index: i,
      text: body,
      charStart,
      charEnd,
    });
  }
  return chunks;
}

/** 由字符偏移推算行号（1 起），供检索结果标注「第 N 行」。 */
export function lineNumberAt(text, charOffset) {
  const source = String(text ?? '');
  const limit = Math.max(0, Math.min(source.length, Math.trunc(Number(charOffset) || 0)));
  let line = 1;
  for (let i = 0; i < limit; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}
