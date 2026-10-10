/**
 * 检索排序：三路信号共用一个接口——BM25 词法打分、归一化向量的余弦相似度、
 * 以及二者的 RRF（倒数排名融合）混合；可选 MMR 去冗余。
 *
 * 算法沿用 dsh-knowledge（Soren-ABT/dsh-knowledge，AGPL-3.0）的已验证设计：
 *   BM25 k1=1.5 b=0.75；RRF_K=60；CJK 采用字符 bigram 分词（中文友好）。
 * 本文件是纯函数、无 IO，便于单测。
 */

/** 余弦相似度（向量已 L2 归一化时点积即余弦）。 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return clamp01(dot);
}

const LATIN_WORD = /[a-z0-9_]+/g;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g;

/**
 * 分词：拉丁词（小写、长度>1）+ CJK 字符 bigram（单字回退）。
 * 中文没有空格，bigram 是无需词典即可获得可用召回的最稳做法。确定性输出。
 */
export function tokenize(text) {
  const tokens = [];
  if (typeof text !== 'string' || text === '') return tokens;
  const lowered = text.toLowerCase();
  for (const match of lowered.match(LATIN_WORD) ?? []) {
    if (match.length > 1) tokens.push(match);
  }
  for (const run of lowered.match(CJK) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** 基于语料构建 BM25 打分器。 */
export function buildBm25(documents) {
  const docTokens = new Map();
  const df = new Map();
  let totalLength = 0;
  for (const doc of documents) {
    const tokens = tokenize(doc.text);
    docTokens.set(doc.id, tokens);
    totalLength += tokens.length;
    const seen = new Set();
    for (const token of tokens) {
      if (!seen.has(token)) {
        df.set(token, (df.get(token) ?? 0) + 1);
        seen.add(token);
      }
    }
  }
  const n = documents.length;
  const avgdl = n > 0 ? totalLength / n : 0;
  return {
    score(id, queryTokens) {
      const tokens = docTokens.get(id);
      if (tokens === undefined || tokens.length === 0) return 0;
      const tf = new Map();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      let sum = 0;
      for (const token of queryTokens) {
        const documentFrequency = df.get(token);
        if (documentFrequency === undefined) continue;
        const idf = Math.log((n - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1);
        const termFrequency = tf.get(token) ?? 0;
        if (termFrequency === 0) continue;
        const norm = termFrequency / (termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / avgdl)));
        sum += idf * norm;
      }
      return sum;
    },
  };
}

/** 把无上界的 BM25 分数映射进 [0,1)。 */
export function normalizeBm25(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw / (raw + 1);
}

export const RRF_K = 60;

/**
 * 倒数排名融合：对若干「id 有序列表」做 RRF，返回 id → 融合分数。
 * weights 与 rankedLists 平行，用于调节每一路的拉力（如向量路权重）。
 */
export function reciprocalRankFusion(rankedLists, weights) {
  const fused = new Map();
  for (let i = 0; i < rankedLists.length; i += 1) {
    const weight = weights?.[i] ?? 1;
    const list = rankedLists[i];
    for (let index = 0; index < list.length; index += 1) {
      const id = list[index];
      fused.set(id, (fused.get(id) ?? 0) + weight / (RRF_K + index + 1));
    }
  }
  return fused;
}

/** 用 MMR 重排结果以提升多样性。 */
export function maximalMarginalRelevance(hits, byId, queryVector, lambda, topK) {
  const withEmbedding = hits.filter((hit) => {
    const embedding = byId.get(hit.id)?.embedding;
    return Array.isArray(embedding) && embedding.length === queryVector.length;
  });
  const withoutEmbedding = hits.filter((hit) => !withEmbedding.includes(hit));
  if (withEmbedding.length < 2) return [...hits];

  const selected = [];
  const remaining = [...withEmbedding];
  const target = Math.min(withEmbedding.length, topK);
  while (selected.length < target && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const hit = remaining[i];
      const embedding = byId.get(hit.id).embedding;
      let maxSimilarity = 0;
      for (const picked of selected) {
        const pickedEmbedding = byId.get(picked.id).embedding;
        maxSimilarity = Math.max(maxSimilarity, cosineSimilarity(embedding, pickedEmbedding));
      }
      const score = lambda * hit.score - (1 - lambda) * maxSimilarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return [...selected, ...remaining, ...withoutEmbedding];
}

/**
 * 按选定策略排序候选，再做阈值过滤与 topK 截断。
 * @param {string} query 查询文本
 * @param {Array<{id:string,text:string,embedding?:number[]}>} candidates 候选分块
 * @param {{mode:string,topK:number,threshold:number,mmr:boolean,mmrLambda:number,queryVector?:number[]}} options
 * @returns {Array<{id:string,score:number,vectorScore?:number,lexicalScore?:number}>}
 */
export function rank(query, candidates, options) {
  const queryTokens = tokenize(query);
  const queryVector = options.queryVector;
  const vectorAvailable = Array.isArray(queryVector)
    && queryVector.length > 0
    && candidates.some((c) => Array.isArray(c.embedding) && c.embedding.length === queryVector.length);

  let mode;
  if (options.mode === 'vector' || options.mode === 'hybrid') mode = options.mode;
  else if (options.mode === 'lexical') mode = 'lexical';
  else mode = vectorAvailable ? 'hybrid' : 'lexical';
  // 没有可用向量时任何模式都只能退化为词法检索，否则会返回空结果。
  if (mode !== 'lexical' && !vectorAvailable) mode = 'lexical';

  const scorer = buildBm25(candidates);
  const lexical = new Map();
  for (const candidate of candidates) {
    lexical.set(candidate.id, normalizeBm25(scorer.score(candidate.id, queryTokens)));
  }

  const vector = new Map();
  if (Array.isArray(queryVector) && queryVector.length > 0) {
    for (const candidate of candidates) {
      if (Array.isArray(candidate.embedding) && candidate.embedding.length === queryVector.length) {
        vector.set(candidate.id, cosineSimilarity(queryVector, candidate.embedding));
      }
    }
  }

  let ranked;
  if (mode === 'vector') {
    ranked = [...vector.entries()].map(([id, score]) => ({ id, score, vectorScore: score }));
  } else if (mode === 'lexical') {
    ranked = [...lexical.entries()].map(([id, score]) => ({ id, score, lexicalScore: score }));
  } else {
    const vectorOrder = [...vector.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const lexicalOrder = [...lexical.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const fused = reciprocalRankFusion([vectorOrder, lexicalOrder], [options.rrfVectorWeight ?? 1, 1]);
    // 归一化：两路都在第 1 名时取得理论最大值，避免分数受 K 值影响。
    const maxFused = ((options.rrfVectorWeight ?? 1) + 1) / (RRF_K + 1);
    ranked = candidates.map((candidate) => ({
      id: candidate.id,
      score: maxFused > 0 ? (fused.get(candidate.id) ?? 0) / maxFused : 0,
      vectorScore: vector.get(candidate.id),
      lexicalScore: lexical.get(candidate.id),
    }));
  }

  ranked.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));

  if (options.mmr && options.mmrLambda > 0 && vectorAvailable) {
    const byId = new Map(candidates.map((c) => [c.id, c]));
    ranked = maximalMarginalRelevance(ranked, byId, queryVector, options.mmrLambda, Math.max(options.topK * 3, 12));
  }

  return ranked.filter((hit) => hit.score >= options.threshold).slice(0, options.topK);
}

/**
 * 结果去重与截断：同一文档相邻分块合并，超预算的片段按字符数截断。
 * 注入上下文前调用，避免同一段落反复占据预算。
 * @param {Array<object>} hits 已排序的命中（含 documentId/chunkIndex/text）
 * @param {{maxChars:number, maxPerDocument:number}} budget 预算
 */
export function dedupeAndTruncate(hits, budget) {
  const maxChars = Number.isFinite(budget?.maxChars) ? budget.maxChars : 12000;
  const maxPerDocument = Number.isFinite(budget?.maxPerDocument) ? budget.maxPerDocument : 3;
  const perDoc = new Map();
  const kept = [];
  let used = 0;

  for (const hit of hits) {
    if (used >= maxChars) break;
    const docId = String(hit.documentId ?? hit.id);
    const count = perDoc.get(docId) ?? 0;
    if (count >= maxPerDocument) continue;
    perDoc.set(docId, count + 1);

    const remaining = maxChars - used;
    let text = String(hit.text ?? '');
    let truncated = false;
    if (text.length > remaining) {
      text = text.slice(0, Math.max(0, remaining));
      truncated = true;
    }
    used += text.length;
    kept.push({ ...hit, text, truncated });
  }
  return kept;
}

/** 生成 RRF 融合的调试快照，供检索测试页展示（词法分/向量分/融合分）。 */
export function explainHit(hit) {
  return {
    id: hit.id,
    score: Number(hit.score?.toFixed(6) ?? 0),
    lexicalScore: hit.lexicalScore === undefined ? null : Number(hit.lexicalScore.toFixed(6)),
    vectorScore: hit.vectorScore === undefined ? null : Number(hit.vectorScore.toFixed(6)),
  };
}
