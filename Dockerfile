FROM node:22-slim AS build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY packages/client/ packages/client/

RUN npm run build

# Patch shared exports to point at compiled JS for production
RUN node -e " \
  const pkg = JSON.parse(require('fs').readFileSync('packages/shared/package.json','utf8')); \
  pkg.main = './dist/index.js'; \
  pkg.types = './dist/index.d.ts'; \
  pkg.exports = { '.': './dist/index.js', './*': './dist/*.js' }; \
  require('fs').writeFileSync('packages/shared/package.json', JSON.stringify(pkg, null, 2) + '\n'); \
"

# ── Extract Plex SQLite from the official deb ────────────────────────
FROM node:22-slim AS plex-sqlite

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Write the URL-extraction script to a file to avoid shell quoting issues
ARG TARGETARCH
COPY <<'GETURL' /tmp/get-plex-url.js
const data = JSON.parse(require('fs').readFileSync('/tmp/plex-downloads.json', 'utf8'));
const plexBuild = process.env.TARGETARCH === 'amd64' ? 'linux-x86_64' : 'linux-aarch64';
const pkg = data.computer.Linux.releases.find(
  r => r.distro === 'debian' && r.build === plexBuild
);
if (pkg) { process.stdout.write(pkg.url); } else { process.exit(1); }
GETURL

RUN curl -fsSL -o /tmp/plex-downloads.json 'https://plex.tv/api/downloads/5.json' && \
    PLEX_DEB_URL=$(TARGETARCH=${TARGETARCH} node /tmp/get-plex-url.js) && \
    curl -fsSL -o /tmp/plex.deb "$PLEX_DEB_URL" && \
    dpkg-deb -x /tmp/plex.deb /plex-extract && \
    rm /tmp/plex.deb /tmp/plex-downloads.json /tmp/get-plex-url.js

# ── Production image ─────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Copy Plex SQLite binary and its bundled libraries from the extracted deb.
# The app auto-discovers it at /usr/lib/plexmediaserver/Plex SQLite.
COPY --from=plex-sqlite /plex-extract/usr/lib/plexmediaserver/ /usr/lib/plexmediaserver/

# Install production dependencies (better-sqlite3 requires native build)
COPY package.json package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN apt-get update && apt-get install -y python3 make g++ && \
    npm ci --omit=dev && \
    apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Copy built packages
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/dist packages/client/dist

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3232

EXPOSE 3232

CMD ["node", "packages/server/dist/index.js"]
