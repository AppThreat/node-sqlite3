import fs from 'node:fs';

export function deleteFile(name) {
    try {
        fs.unlinkSync(name);
    } catch (err) {
        if (
            err.errno !== process.ENOENT &&
            err.code !== 'ENOENT' &&
            err.syscall !== 'unlink'
        ) {
            throw err;
        }
    }
}

export function ensureExists(name, _cb) {
    // recursive, not existsSync-then-mkdir: node --test runs each file in
    // its own process, and two before-hooks creating test/tmp at the same
    // moment raced the check (EEXIST cancelled a whole suite once). mkdir
    // -p semantics are race-free and tolerate the existing directory.
    fs.mkdirSync(name, { recursive: true });
}

export function fileDoesNotExist(name) {
    try {
        fs.statSync(name);
    } catch (err) {
        if (
            err.errno !== process.ENOENT &&
            err.code !== 'ENOENT' &&
            err.syscall !== 'unlink'
        ) {
            throw err;
        }
    }
}

export function fileExists(name) {
    fs.statSync(name);
}
