// Type-side twin of lib/sqlite3-binding.js: resolves the runtime import to
// the hand-written native declarations in lib/native.d.ts so the whole JS
// layer is checked against the addon's real shape (and never against the
// .js file itself, whose default export would be `any`).
import binding, {
    Backup,
    Blob,
    Database,
    Session,
    Statement,
} from './native.js';

export default binding;

export type { NativeBinding } from './native.js';
export { Backup, Blob, Database, Session, Statement };
