FROM node:24.13.1-bookworm-slim
ARG APP_REVISION=local
LABEL org.opencontainers.image.source="https://github.com/Herowoo/c11-harbor"
LABEL org.opencontainers.image.revision="${APP_REVISION}"
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 APP_REVISION=${APP_REVISION}
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
