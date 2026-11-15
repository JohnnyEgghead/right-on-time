# P1-DEPLOY: the 1 app image (SPECIFICATIONS SD-3: web, worker and pbs, 3 entry points; Compose
# picks the command; the one-shot migrate step of F-150 runs from it too). Build context: the repo
# root. Only the files the allowlist in Dockerfile.dockerignore admits are sent.
# Node 26 runs the TypeScript sources directly (type stripping); the only build step is the web
# app's pages (Next.js, SD-2), made in the "web" stage.
#
# deps (P2-KERNEL, F-107): the production dependencies of web, worker and pbs (the workspace
# packages they use and their third-party closure: pg, zod, temporal-polyfill, and since P2-SHELL
# next and react), installed from the committed lockfile on the build machine's own platform.
# Optional dependencies are installed for the TARGET platform (pnpm --os/--cpu/--libc), not the build
# machine's: since P6-PHOTO-THUMBS the server runs sharp (SPECIFICATIONS SD-32, the photo small
# copy), whose native code is 2 optional packages per platform (@img/sharp-linux-<cpu> and
# @img/sharp-libvips-linux-<cpu>; owner ruling 0963dc1d allows libvips's LGPL on the server only).
# They are prebuilt files, fetched with no install script, so the stage still runs on the build
# platform with no emulation. next's SWC compiler binaries, the only other optional native packages
# in the closure, are deleted again: the server never runs them (the web stage compiles the pages;
# images are unoptimized). The release stage below still has no RUN step: a cross-architecture build
# (the Mac is arm64, the server amd64) needs no emulation.
ARG NODE_IMAGE=node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN npm install --global --no-fund --no-audit --no-update-notifier pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/pbs/package.json apps/pbs/package.json
COPY packages packages
# P2-SETUP: @bw/setup and its closure (the generator, the import) too, so the one-shot setup
# service runs from this image; the generator's committed inputs (packages/generator/*.json) ship
# with it (Dockerfile.dockerignore; F-237).
ARG TARGETARCH
RUN cpu=$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "${TARGETARCH:-x64}") \
 && pnpm install --frozen-lockfile --prod --os linux --cpu "$cpu" --libc glibc --ignore-scripts --filter bw-web... --filter bw-worker... --filter bw-pbs... --filter @bw/setup... \
 && rm -rf node_modules/.pnpm/@next+swc-* \
 && ls -d node_modules/.pnpm/@img+sharp-linux-$cpu@* node_modules/.pnpm/@img+sharp-libvips-linux-$cpu@* \
 && mkdir -p /out/db-login/web /out/db-login/worker /out/db-login/pbs /out/photos

# web (P2-SHELL): the Next.js build of the pages, on the BUILD platform; its output is platform-free
# JavaScript. The web process (apps/web/src/server.ts) serves it through Next's request handler,
# behind the kernel, the page gate and the 11.5 headers. BW_WEB_PREVIEW=1 builds the harness app
# (the shell preview routes, for the stack tests) into .next-preview; the default build, the one
# deploy.sh ships, never contains them.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
ARG BW_WEB_PREVIEW=
ENV NEXT_TELEMETRY_DISABLED=1 CI=1 BW_WEB_PREVIEW=${BW_WEB_PREVIEW}
WORKDIR /src
RUN npm install --global --no-fund --no-audit --no-update-notifier pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages packages
RUN pnpm install --frozen-lockfile --ignore-scripts --filter bw-web...
COPY apps/web apps/web
RUN cd apps/web && node node_modules/next/dist/bin/next build \
 && dist=$([ "$BW_WEB_PREVIEW" = 1 ] && echo .next-preview || echo .next) \
 && mkdir -p /out && cp -R "$dist" "/out/$dist" && rm -rf "/out/$dist/cache" "/out/$dist/standalone"

FROM ${NODE_IMAGE} AS app
# SPECIFICATIONS 11.1: PUBLIC_COMMIT is "unknown" on a developer build; SD-40's release build sets it.
ARG PUBLIC_COMMIT=unknown
# The private commit the image was built from (deploy.sh), shown by "docker image inspect".
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
ARG BW_WEB_PREVIEW=
# BW_WEB_PREVIEW picks the build the web process serves (.next-preview for the harness image).
ENV NODE_ENV=production PUBLIC_COMMIT=$PUBLIC_COMMIT NEXT_TELEMETRY_DISABLED=1 BW_WEB_PREVIEW=${BW_WEB_PREVIEW}
WORKDIR /app
COPY --from=deps /app /app
COPY --from=web /out/ apps/web/
COPY apps/web/src apps/web/src
COPY apps/worker/src apps/worker/src
COPY apps/pbs/src apps/pbs/src
# F-248: the license texts and the third-party credits (CC-BY-4.0 asks for the caniuse-lite credit) ship with the code.
COPY LICENSE LICENSE-DATA.md THIRD-PARTY-NOTICES.md ./
# The process login password directories (F-150): each named volume mounted here starts as a copy
# of its directory, owned by node, so the migrate step (user node) can write the password files.
COPY --from=deps --chown=node:node /out/db-login /var/lib/bw/db-login
# P3-ITEMS (SD-32): the photo volume's mount point, owned by node, so the named volume mounted there starts writable
# by the web process (PHOTOS_DIR, /data/photos).
COPY --from=deps --chown=node:node /out/photos /data/photos
USER node
EXPOSE 3000
CMD ["node", "apps/web/src/server.ts"]

# The rollback drill's planted image (deploy.sh --drill): the same image with a web process whose
# /healthz answers PLANT_STATUS. Never the default target.
FROM app AS plant
COPY infra/deploy/plant/healthz-plant.mjs apps/web/src/server.ts
ARG PLANT_STATUS=500
ENV PLANT_STATUS=$PLANT_STATUS

# The release image: the default target, last so a plain "docker build" never builds the plant.
FROM app AS release
