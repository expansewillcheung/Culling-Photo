// Helpers for browser tests: fetch fixture files served by the vite dev server.
export const RAW_DIR = '/tests/fixtures/raw/';
export const GEN_DIR = '/tests/fixtures/gen/';

export async function fixtureBlob(path: string): Promise<Blob> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fixture ${path}: ${res.status}`);
  return res.blob();
}

export async function fixtureFile(path: string): Promise<File> {
  const blob = await fixtureBlob(path);
  return new File([blob], path.split('/').pop()!, { lastModified: 1_700_000_000_000 });
}
