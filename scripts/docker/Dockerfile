# ==========================================
# TSMusicBot Docker Image
# One-click deployment — all dependencies included
# ==========================================

# --- Stage 1: Build backend + frontend ---
FROM node:20-slim AS builder

# Install build tools for native modules (opus, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install backend dependencies
COPY package*.json ./
RUN npm ci

# Install frontend dependencies
COPY web/package*.json ./web/
RUN cd web && npm ci

# Copy source and build
COPY . .
RUN npm run build

# --- Stage 2: Production image ---
FROM node:20-slim

# Install only runtime native build tools (needed for native module rebuild)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built output
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/package*.json ./

# Install production dependencies (includes ffmpeg-static, opus, sqlite3)
# These need to compile native addons inside the container
RUN npm ci --production && npm cache clean --force

# Remove build tools to reduce image size
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# FFmpeg is bundled via ffmpeg-static — no system ffmpeg needed

# Data directory for database, cookies, logs
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
