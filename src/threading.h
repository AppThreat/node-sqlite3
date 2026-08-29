#ifndef NODE_SQLITE3_SRC_THREADING_H
#define NODE_SQLITE3_SRC_THREADING_H

#include <stdio.h>
#include <stdlib.h>

#include <uv.h>

#define NODE_SQLITE3_MUTEX_t uv_mutex_t mutex;
// A silently uninitialised mutex is worse than a crash: every later
// lock/unlock would be undefined behaviour. uv_mutex_init only fails on
// resource exhaustion, which is not survivable here anyway. The trailing
// semicolon is part of the macro: existing call sites omit their own.
#define NODE_SQLITE3_MUTEX_INIT do { \
    int mutex_init_rc_ = uv_mutex_init(&mutex); \
    if (mutex_init_rc_ != 0) { \
        fprintf(stderr, "node-sqlite3: uv_mutex_init failed: %s\n", \
            uv_strerror(mutex_init_rc_)); \
        abort(); \
    } \
} while (0);
#define NODE_SQLITE3_MUTEX_LOCK(m) uv_mutex_lock(m);
#define NODE_SQLITE3_MUTEX_UNLOCK(m) uv_mutex_unlock(m);
#define NODE_SQLITE3_MUTEX_DESTROY uv_mutex_destroy(&mutex);

#endif // NODE_SQLITE3_SRC_THREADING_H
