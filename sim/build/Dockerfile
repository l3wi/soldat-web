# Toolchain recipe adapted from humanova/soldat-web (MIT), tools/setup-fpc.sh
# at 31bb3d5cb0eaa2eefd20b205b646feb8ba9c92fd. No Clang linker patch:
# the simulation links Pascal objects only. Full attribution: sim/build/NOTICE.
FROM debian:bookworm-slim AS compiler
ARG FPC_COMMIT=bcd728860dcd953cb6f3bbda788eab07b0d16c85
ARG JOBS=4
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git make gcc libc6-dev fp-compiler fp-units-base fp-units-fcl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY patches/fpc-aarch64-unaligned-smallint.patch /tmp/fpc-aarch64-unaligned-smallint.patch
RUN git init -q && git remote add origin https://gitlab.com/freepascal.org/fpc/source.git \
    && git fetch --depth 1 origin "$FPC_COMMIT" && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$FPC_COMMIT" \
    && git apply /tmp/fpc-aarch64-unaligned-smallint.patch
RUN make -j"$JOBS" all OPT="-O-" \
    && make install INSTALL_PREFIX=/opt/fpc \
    && make -j"$JOBS" all OS_TARGET=wasip1 CPU_TARGET=wasm32 BINUTILSPREFIX= \
       OPT="-O-" PP="/opt/fpc/bin/fpc" \
    && make crossinstall OS_TARGET=wasip1 CPU_TARGET=wasm32 BINUTILSPREFIX= INSTALL_PREFIX=/opt/fpc \
    && printf '%s\n' '-Fu/opt/fpc/lib/fpc/3.3.1/units/$fpctarget/*' > /opt/fpc/fpc.cfg \
    && printf '%s\n' '#!/bin/sh' 'exec /opt/fpc/bin/fpc -n @/opt/fpc/fpc.cfg "$@"' > /opt/fpc/compile \
    && chmod +x /opt/fpc/compile \
    && printf '%s\n' "$FPC_COMMIT" > /opt/fpc/COMMIT
RUN sha256sum /tmp/fpc-aarch64-unaligned-smallint.patch | cut -d ' ' -f 1 > /opt/fpc/PATCH_SHA256

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git make build-essential clang cmake libssl-dev \
    protobuf-compiler libprotobuf-dev zlib1g-dev pkg-config libphysfs-dev python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=compiler /opt/fpc /opt/fpc
RUN ln -s /opt/fpc/compile /usr/local/bin/fpc
ENV PATH="/opt/fpc/lib/fpc/3.3.1:${PATH}"
WORKDIR /work
