// Graceful degradation: unreachable model / library URLs resolve to null, never throw.
import { expect, test } from 'vitest';
import { embedImage, embedLoadError, loadEmbedder } from './embed';
import { detectFaces, faceLoadError, loadFaceLandmarker } from './faces';

const DEAD = 'http://127.0.0.1:9/unreachable';

test('faces: unreachable model → null', async () => {
  const opts = { modelUrl: DEAD + '/face_landmarker.task' };
  expect(await loadFaceLandmarker(opts)).toBeNull();
  expect(faceLoadError()).toBeTruthy();
  expect(await detectFaces(new ImageData(64, 64), opts)).toBeNull();
});

test('embed: unreachable library → null', async () => {
  const opts = { libraryUrl: DEAD + '/transformers.js' };
  expect(await loadEmbedder(opts)).toBeNull();
  expect(embedLoadError()).toBeTruthy();
  expect(await embedImage(new ImageData(64, 64), opts)).toBeNull();
});
