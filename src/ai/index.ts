// CONTRACT (owned by ai agent). Pure functions over ImageData run in workers; model-based
// detectors lazily load and must degrade gracefully (return null) when unavailable/offline.
//
// Pure (worker-safe, node-testable; accept ImageData or any {data,width,height} RGBA):
//   blurScore(img) → number        higher = sharper; at ~512px long edge: > 1 sharp, < 0.3 blurry
//   blurDetails(img)               per-tile / centre / global breakdown
//   exposureStats(img)             {mean, clippedHighlights, clippedShadows} (fractions)
//   pHash(img) / dHash(img) → bigint, hamming(a,b), hashToHex / hexToHash
//   analyzePixels(img)             all of the above with one luma pass
//   groupBursts(items, {maxGapMs=2000, maxHamming=12, minCosine=0.92}) → group id per item
//   groupSimilar(items, {threshold=0.9, window=64}) → group id per item (embeddings / hash)
//   pickBest(members) → id, smartCullSuggestions(photos) → {id, reason, reasons}[]
// Model-based (lazy, return null when unavailable):
//   detectFaces(img) (./faces), embedImage(img) (./embed)
// Worker: ./ai.worker (comlink), main-thread helper createAiWorker() in ./client.
export type { Pixels } from './pixels';
export {
  blurScore,
  blurDetails,
  exposureStats,
  laplacianVariance,
  BLUR_NORM,
  SHARP_THRESHOLD,
  BLURRY_THRESHOLD,
  type BlurDetails,
  type ExposureStats,
} from './blur';
export { pHash, dHash, hamming, hashToHex, hexToHash } from './hash';
export { analyzePixels, type PixelAnalysis } from './analyze';
export {
  groupBursts,
  groupSimilar,
  cosineSim,
  type BurstItem,
  type BurstOptions,
  type SimilarItem,
  type SimilarOptions,
} from './group';
export {
  pickBest,
  qualityScore,
  sharpnessPoints,
  smartCullSuggestions,
  PICK_WEIGHTS,
  type CandidateInfo,
  type CullPhoto,
  type CullReason,
  type CullSuggestion,
  type CullOptions,
} from './score';
