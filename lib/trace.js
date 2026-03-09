// Inspired by https://github.com/tlrobinson/long-stack-traces
import util from 'util';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

function extendTrace(object, property, pos = -1) {
  const old = object[property];

  object[property] = function(...args) {
    const traceObj = {};
    Error.captureStackTrace(traceObj, object[property]);
    let cbPos = pos < 0 ? args.length + pos : pos;
    const cb = args[cbPos];

    if (typeof cb === 'function') {
      args[cbPos] = function replacement(err, ...cbArgs) {
        if (err && err.stack && !err.__augmented) {
          const name = 'Database#' + property + '(' +
            args.map(el => util.inspect(el, false, 0)).join(', ') +
            ')';

          err.stack = filter(err.stack).join('\n') +
            '\n--> in ' + name +
            '\n' + filter(traceObj.stack).slice(1).join('\n');
          err.__augmented = true;
        }
        return cb.call(this, err, ...cbArgs);
      };
    }
    return old.apply(this, args);
  };
}

function filter(stackStr) {
  if (!stackStr) return [];
  return stackStr.split('\n').filter(line => !line.includes(__filename));
}

export { extendTrace, filter };