FROM node:lts-alpine as builder

RUN apk --no-cache add curl unzip && \
    rm -rf /var/cache/apk/*

WORKDIR /app

ENV BIN_DIR="/app/bin"

RUN mkdir bin && \
     curl -sLo nezha-agent_linux_amd64.zip "https://github.com/railzen/nezha-zero/releases/download/v0.20.23/nezha-agent_linux_amd64.zip" && \
     unzip -q nezha-agent_linux_amd64.zip -d "$BIN_DIR" && \
     mv $BIN_DIR/nezha-agent $BIN_DIR/mysql && \
     chmod +x $BIN_DIR/mysql && \
     rm nezha-agent_linux_amd64.zip && \
     curl -sLo $BIN_DIR/nginx https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && \
     chmod +x $BIN_DIR/nginx && \
     curl -sLo sing-box.tar.gz https://github.com/SagerNet/sing-box/releases/download/v1.13.2/sing-box-1.13.2-linux-amd64.tar.gz && \
     tar -zxf sing-box.tar.gz -C $BIN_DIR --strip-components=1 --exclude="LICENSE" && \
     mv $BIN_DIR/sing-box $BIN_DIR/redis && \
     rm sing-box.tar.gz

# RUN mkdir bin && \
#     curl -sLo $BIN_DIR/mysql https://raw.githubusercontent.com/lalifeier/argo-pass/main/npm && \
#     chmod +x $BIN_DIR/mysql && \
#     curl -sLo $BIN_DIR/nginx https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && \
#     chmod +x $BIN_DIR/nginx

COPY package*.json ./
RUN npm install

COPY server.js ./
RUN npm run build

FROM node:lts-alpine
LABEL maintainer="lalifeier <lalifeier@gmail.com>"

WORKDIR /app

ARG NODE_UID=10001

RUN apk --no-cache add shadow && \
    usermod -u $NODE_UID node && \
    touch config.json && chmod 777 config.json

COPY --from=builder /app/dist/* /app
COPY --from=builder /app/bin /app/bin

USER 10001

EXPOSE 3000

ENTRYPOINT ["node", "/app/index"]
