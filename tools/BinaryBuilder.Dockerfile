ARG NODE_VERSION=20
ARG VARIANT=bookworm

FROM node:$NODE_VERSION-$VARIANT

ARG VARIANT

RUN if case $VARIANT in "alpine"*) true;; *) false;; esac; then apk add build-base python3 --update-cache ; fi

WORKDIR /usr/src/build

COPY . .
RUN npm install --ignore-scripts

RUN if case $VARIANT in "alpine"*) true;; *) false;; esac; then \
        npm run prebuild -- --tag-libc; \
    else \
        CFLAGS="${CFLAGS:-} -include ../src/gcc-preinclude.h" \
        CXXFLAGS="${CXXFLAGS:-} -include ../src/gcc-preinclude.h" \
        npm run prebuild -- --tag-libc; \
    fi

RUN if case $VARIANT in "alpine"*) false;; *) true;; esac; then ldd prebuilds/*/*.node; nm prebuilds/*/*.node | grep \"GLIBC_\" | c++filt || true ; fi

RUN npm run test && ls -l prebuilds

CMD ["sh"]