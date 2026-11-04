FROM node:22-alpine
RUN apk add --no-cache python3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY ops/agent-runtime/restricted-agent/conformance/*.mjs ./ops/agent-runtime/restricted-agent/conformance/
RUN mkdir -p /state/agents/one/gateway /state/agents/two/gateway && chown -R 1000:1000 /state && chmod 700 /state/agents/one/gateway /state/agents/two/gateway
USER 1000:1000
CMD ["node", "ops/agent-runtime/restricted-agent/conformance/socket_service.mjs"]
