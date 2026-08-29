ARG NODE_VERSION=24
ARG VARIANT=bookworm

FROM node:$NODE_VERSION-$VARIANT

ARG VARIANT

RUN if case $VARIANT in "alpine"*) true;; *) false;; esac; then apk add build-base python3 --update-cache ; fi

WORKDIR /usr/src/build

COPY . .
# Install the exact pnpm version pinned in packageManager; an unpinned pnpm
# resolves to whatever is latest at build time. pnpm 11 publishes static
# linux binaries (@pnpm/linuxstatic-x64/arm64) that run on both glibc and
# musl, so this works on Alpine — unlike pnpm 10.x releases that shipped no
# musl build (the failure mode cdxgen documented in its binary-builds.yml).
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('pnpm@')[1].split('+')[0]")" \
    && pnpm install --frozen-lockfile --ignore-scripts

RUN if case $VARIANT in "alpine"*) true;; *) false;; esac; then \
        pnpm run prebuild --tag-libc; \
    else \
        CFLAGS="${CFLAGS:-} -include ../src/gcc-preinclude.h" \
        CXXFLAGS="${CXXFLAGS:-} -include ../src/gcc-preinclude.h" \
        pnpm run prebuild --tag-libc; \
    fi

RUN if case $VARIANT in "alpine"*) false;; *) true;; esac; then ldd prebuilds/*/*.node; nm prebuilds/*/*.node | grep \"GLIBC_\" | c++filt || true ; fi

RUN pnpm run test && ls -l prebuilds

CMD ["sh"]
