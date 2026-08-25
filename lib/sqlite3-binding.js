import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import nodeGypBuild from 'node-gyp-build';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');

const binding = nodeGypBuild(rootDir);

export default binding;
