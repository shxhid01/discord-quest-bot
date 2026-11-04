FROM node:22-alpine

RUN apk add --no-cache tini
WORKDIR /app

COPY --chown=node:node quest-bot-headless.mjs ./
COPY --chown=node:node lib/ ./lib/
RUN mkdir -p /app/data && chown node:node /app/data

USER node
ENV DQUEST_STATE_DIR=/app/data \
    DQUEST_LOG_FILE=/app/data/orion.log \
    NODE_ENV=production

HEALTHCHECK --interval=15m --timeout=10s --start-period=5m --retries=3 \
  CMD node -e "const f='/app/data/.heartbeat';try{const a=Date.now()-require('fs').statSync(f).mtimeMs;process.exit(a<28*3600e3?0:1)}catch{process.exit(1)}"

ENTRYPOINT ["/sbin/tini", "--", "node", "quest-bot-headless.mjs"]
CMD ["--all", "--claim", "--loop", "86400"]