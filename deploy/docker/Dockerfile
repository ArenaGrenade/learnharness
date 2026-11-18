ARG BUILDER_IMAGE=homelab-learnharness-build:node26
FROM ${BUILDER_IMAGE}
# Context is the curated upstream standalone payload, never the source checkout.
COPY --chown=node:node . /app
ENV NODE_ENV=production LH_DATA_DIR=/appdata/data LH_AUTH_FILE=/appdata/auth.json HOSTNAME=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server.js"]
