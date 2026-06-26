/**
 * Token proxy. A real BPE tokenizer would be marginally more accurate, but the
 * gate is a COMPARISON — the same estimator applied to both systems keeps it
 * fair, and chars/4 tracks GPT/Claude tokenization within a few percent for the
 * short structured strings we measure. Absolute numbers are approximate;
 * relative numbers (the gate criterion) are sound.
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
