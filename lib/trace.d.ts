/**
 * A callback-mode method that this module can wrap.
 */
export type Traceable = (this: unknown, ...args: unknown[]) => unknown;
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
declare function extendTrace(object: Record<string, Traceable>, property: string, pos?: number): void;
/**
 * Drops this file's own frames from a stack string.
 *
 * @param {string | undefined} stackStr the stack to filter.
 * @returns {string[]} the surviving frames.
 */
declare function filter(stackStr: string | undefined): string[];
export { extendTrace, filter };
