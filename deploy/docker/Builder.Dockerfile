FROM node:26-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1 CHROME_PATH=/usr/bin/chromium ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /app
