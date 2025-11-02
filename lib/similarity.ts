export function cosineSimilarity(a: number[], b: number[]) {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (magA * magB);
}


export function textSimilarity(a: string, b: string) {
  const tokenize = (s: string) =>
    s.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);

  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));

  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size || 1;

  return inter / union;
}
