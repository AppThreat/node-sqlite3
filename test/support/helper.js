import fs from 'fs';

export function deleteFile(name) {
    try {
        fs.unlinkSync(name);
    } catch(err) {
        if (err.errno !== process.ENOENT && err.code !== 'ENOENT' && err.syscall !== 'unlink') {
            throw err;
        }
    }
}

export function ensureExists(name, cb) {
    if (!fs.existsSync(name)) {
        fs.mkdirSync(name);
    }
}

export function fileDoesNotExist(name) {
    try {
        fs.statSync(name);
    } catch(err) {
        if (err.errno !== process.ENOENT && err.code !== 'ENOENT' && err.syscall !== 'unlink') {
            throw err;
        }
    }
};

export function fileExists(name) {
    fs.statSync(name);
};