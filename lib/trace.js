// Long-stack-trace support, after tlrobinson/long-stack-traces.
//
// extendTrace wraps a callback-mode method so that errors delivered to
// its callback carry the stack of the call site (filtered of this
// file's own frames). verbose() applies it to every method core.

import { fileURLToPath } from 'node:url';
import util from 'node:util';

const __filename = fileURLToPath(import.meta.url);

/**
 * A callback-mode method that this module can wrap.
 *
 * @typedef {(this: unknown, ...args: unknown[]) => unknown} Traceable
 */

/**
 * Wraps `object[property]` so that an error delivered to its callback
 * carries the call site's stack, augmented with the wrapped call.
 *
 * The callback is found at `pos` (negative counts from the end, the
 * default -1 meaning the last argument). Only callback-mode calls are
 * affected: without a function in that position the wrapper is a
 * pass-through, which is why verbose() traces the callback cores and
 * then rebuilds the dual-mode wrappers around them.
 *
 * @param {Record<string, Traceable>} object the holder of the method.
 * @param {string} property the method name on `object`.
 * @param {number} [pos=-1] position of the callback argument.
 * @returns {void}
 */
function extendTrace(object, property, pos = -1) {
    const old = object[property];

    /**
     * @param {...unknown} args
     * @this unknown
     * @returns {unknown}
     */
    object[property] = function (...args) {
        /** @type {{ stack?: string }} */
        const traceObj = {};
        Error.captureStackTrace(traceObj, object[property]);
        const cbPos = pos < 0 ? args.length + pos : pos;
        const cb = args[cbPos];

        if (typeof cb === 'function') {
            /**
             * @param {{ stack?: string, __augmented?: boolean }} err
             * @param {...unknown} cbArgs
             */
            args[cbPos] = function replacement(err, ...cbArgs) {
                if (err?.stack && !err.__augmented) {
                    const name =
                        'Database#' +
                        property +
                        '(' +
                        args
                            .map((el) => util.inspect(el, false, 0))
                            .join(', ') +
                        ')';

                    err.stack =
                        filter(err.stack).join('\n') +
                        '\n--> in ' +
                        name +
                        '\n' +
                        filter(traceObj.stack).slice(1).join('\n');
                    err.__augmented = true;
                }
                return cb.call(this, err, ...cbArgs);
            };
        }
        return old.apply(this, args);
    };
}

/**
 * Drops this file's own frames from a stack string.
 *
 * @param {string | undefined} stackStr the stack to filter.
 * @returns {string[]} the surviving frames.
 */
function filter(stackStr) {
    if (!stackStr) return [];
    return stackStr.split('\n').filter((line) => !line.includes(__filename));
}

export { extendTrace, filter };
