// Inspired by https://github.com/tlrobinson/long-stack-traces
import util from 'util';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

function extendTrace(object, property, pos) {
  const old = object[property];
  object[property] = function() {
    const error = new Error();
    const name = 'Database#run(' +
      Array.prototype.slice.call(arguments).map(function(el) {
        return util.inspect(el, false, 0);
      }).join(', ') + ')';

    if (typeof pos === 'undefined') pos = -1;
    if (pos < 0) pos += arguments.length;
    const cb = arguments[pos];
    if (typeof arguments[pos] === 'function') {
      arguments[pos] = function replacement() {
        const err = arguments[0];
        if (err && err.stack && !err.__augmented) {
          err.stack = filter(err).join('\n');
          err.stack += '\n--> in ' + name;
          err.stack += '\n' + filter(error).slice(1).join('\n');
          err.__augmented = true;
        }
        return cb.apply(this, arguments);
      };
    }
    return old.apply(this, arguments);
  };
}

function filter(error) {
  return error.stack.split('\n').filter(function(line) {
    return line.indexOf(__filename) < 0;
  });
}

export { extendTrace, filter };