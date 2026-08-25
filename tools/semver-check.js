import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import semver from 'semver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const supportedVersions = '24.0.0';

function checkEngines(modulePath) {
    const packageJsonPath = path.join(modulePath, 'package.json');

    if (!fs.existsSync(packageJsonPath)) return;

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath));
    const engines = packageJson.engines;

    if (engines?.node) {
        const minVersion = semver.minVersion(engines.node);

        if (semver.gt(minVersion, supportedVersions)) {
            console.log(
                `${packageJson.name}@${packageJson.version} requires ${engines.node}`,
            );
            process.exit(1);
        }
    }
}

const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json')),
);

const allDependencies = Object.keys(packageJson.dependencies || {}).concat(
    Object.keys(packageJson.optionalDependencies || {}),
);

for (const dependency of allDependencies) {
    const modulePath = path.join(__dirname, '..', 'node_modules', dependency);
    checkEngines(modulePath);
}
