import type { FileSource } from '../fs/FileSource';
import type { Session } from './session';

/** Connect persistence (SQLite) and XMP sidecar IO to a session. Filled in after integration. */
export async function wireSession(_s: Session, _source: FileSource): Promise<void> {}
