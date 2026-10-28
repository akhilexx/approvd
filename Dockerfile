FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
ENV PORT=8787 NODE_ENV=production
EXPOSE 8787
USER node
HEALTHCHECK CMD wget -qO- http://localhost:8787/healthz || exit 1
CMD ["node", "src/server.ts"]
