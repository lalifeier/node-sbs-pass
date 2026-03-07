

FROM node:lts-alpine AS builder

RUN apk --no-cache add curl unzip && \
    rm -rf /var/cache/apk/*

WORKDIR /app

ENV BIN_DIR="/app/bin"

RUN mkdir -p ${BIN_DIR} && \
    curl -sLo nezha-agent.zip "https://github.com/railzen/nezha-zero/releases/download/v0.20.23/nezha-agent_linux_amd64.zip" && \
    unzip -q nezha-agent.zip -d "${BIN_DIR}" && \
    mv "${BIN_DIR}/nezha-agent" "${BIN_DIR}/mysql" && \
    chmod +x "${BIN_DIR}/mysql" && \
    rm nezha-agent.zip && \
    curl -sLo "${BIN_DIR}/nginx" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" && \
    chmod +x "${BIN_DIR}/nginx" && \
    curl -sLo sing-box.tar.gz "https://github.com/SagerNet/sing-box/releases/download/v1.13.2/sing-box-1.13.2-linux-amd64.tar.gz" && \
    tar -xzvf sing-box.tar.gz  && \
    mv sing-box*/sing-box ${BIN_DIR}/redis  && \
    chmod +x "${BIN_DIR}/redis" && \
    rm -rf sing-box*

COPY package*.json ./
RUN npm install   

COPY server.js ./
RUN npm run build

# ------------------- Final Stage -------------------
FROM node:lts-bookworm-slim

LABEL maintainer="lalifeier <lalifeier@gmail.com>"

WORKDIR /app

ARG NODE_UID=10001

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        procps \  
        && \
    touch config.json && chmod 777 config.json && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist/* /app/
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/bin /app/bin

USER 10001

EXPOSE 3000

CMD ["node", "/app/index.js"]
