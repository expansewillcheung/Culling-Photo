// Minimal typings for vendored decoder entry points that ship without usable .d.ts.

declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  export interface HeifImage {
    handle: unknown;
    get_width(): number;
    get_height(): number;
    display(
      target: { data: Uint8ClampedArray; width: number; height: number },
      cb: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
    ): void;
    free(): void;
  }
  export interface HeifDecoder {
    decoder: unknown;
    decode(data: Uint8Array): HeifImage[];
  }
  export interface LibHeif {
    HeifDecoder: new () => HeifDecoder;
    heif_context_free(ctx: unknown): void;
    heif_image_handle_is_primary_image?(handle: unknown): number;
    heif_get_version?(): string;
  }
  const factory: (opts?: { onRuntimeInitialized?: () => void; onAbort?: (what: unknown) => void }) => LibHeif;
  export default factory;
}
