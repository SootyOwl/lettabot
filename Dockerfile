FROM node:22-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Link CLI binaries so the agent can use lettabot-message etc.
RUN ln -s /app/dist/cli.js /usr/local/bin/lettabot && \
    ln -s /app/dist/cron/cli.js /usr/local/bin/lettabot-schedule && \
    ln -s /app/dist/cli/message.js /usr/local/bin/lettabot-message && \
    ln -s /app/dist/cli/react.js /usr/local/bin/lettabot-react && \
    ln -s /app/dist/cli/history.js /usr/local/bin/lettabot-history && \
    ln -s /app/dist/cli/channels.js /usr/local/bin/lettabot-channels

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/main.js"]
