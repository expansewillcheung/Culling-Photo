import { blurScore, type ExposureStats, exposureStats } from './blur';
import { dHash, pHash } from './hash';
import { type Pixels, toLuma } from './pixels';

export interface PixelAnalysis {
  blurScore: number;
  phash: bigint;
  dhash: bigint;
  exposure: ExposureStats;
}

/** All pure per-image metrics, sharing one luma conversion. Pass ~512px long-edge pixels. */
export function analyzePixels(img: Pixels): PixelAnalysis {
  const y = toLuma(img);
  return {
    blurScore: blurScore(img, y),
    phash: pHash(img, y),
    dhash: dHash(img, y),
    exposure: exposureStats(img, y),
  };
}
