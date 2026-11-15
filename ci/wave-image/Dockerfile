# The wave run's prebuilt CI image (F-409, owner ruling ffd9f9ff). Built by ci/wave-run.sh on Spectre only when
# its content key (ci/wave-image-key.ts) has no image yet. Holds what a run used to install each time:
#   apt pins, pnpm, the pnpm store (/root/.pnpm-store, filled from the lockfile) and both browsers with their
#   system libraries (/ms-playwright). No node_modules and no source: each run still does
#   pnpm install --frozen-lockfile --offline against the exported tree, so lockfile drift still goes red.
# The build context is exactly the key's input files (ci/wave-image-key.ts stage); nothing else is copied in.
ARG BASE
FROM ${BASE}
ARG APT_PINS
ARG PNPM_VERSION
ARG KEY
LABEL bw.ci.image=1 bw.ci.key=${KEY}
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ${APT_PINS} && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}"
COPY . /seed
WORKDIR /seed
RUN pnpm install --frozen-lockfile --store-dir /root/.pnpm-store \
 && pnpm exec playwright install --with-deps chromium webkit \
 && rm -rf /var/lib/apt/lists/* /seed/node_modules /seed/apps/*/node_modules /seed/packages/*/node_modules
# F-499: WebKit's software GL. The step above brings bookworm's Mesa 22.3.6, whose llvmpipe reads another GL context's
# scene without that scene's lock (lp_setup_is_resource_referenced). WebKit draws a page's WebGL on its main thread and
# composites on another thread, 2 contexts on 1 llvmpipe screen, so a map page could crash its web process (SIGSEGV in
# lp_scene_is_resource_referenced; the wave runs at 5f39de0 and its re-run). Mesa 25.0 takes the lock there. Exact
# versions from bookworm-backports, first seen 2025-07-16 (Mesa) and 2024-09-23 (libdrm), so F-106's 14-day rule holds;
# a version that leaves the archive fails the build loudly. Chromium is unaffected (its own SwiftShader).
RUN printf 'Types: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm-backports\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
      >/etc/apt/sources.list.d/bookworm-backports.sources \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      libgl1-mesa-dri=25.0.7-2~bpo12+1 libegl-mesa0=25.0.7-2~bpo12+1 libgbm1=25.0.7-2~bpo12+1 \
      libglx-mesa0=25.0.7-2~bpo12+1 mesa-libgallium=25.0.7-2~bpo12+1 \
      libdrm-common=2.4.123-1~bpo12+1 libdrm2=2.4.123-1~bpo12+1 libdrm-amdgpu1=2.4.123-1~bpo12+1 \
      libdrm-intel1=2.4.123-1~bpo12+1 libdrm-nouveau2=2.4.123-1~bpo12+1 libdrm-radeon1=2.4.123-1~bpo12+1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /
RUN rm -rf /seed
