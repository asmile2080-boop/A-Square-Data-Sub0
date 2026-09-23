# Minimal image — no build step, no external runtime dependencies unless
# DATABASE_URL is set (Postgres mode), in which case 'pg' installs here.
FROM node:22-slim

WORKDIR /app

COPY package.json .
# --omit=optional would skip 'pg' — don't do that here, since this image
# is meant for production where you likely ARE using Postgres. Installing
# it is harmless even if you end up running SQLite mode.
RUN npm install --omit=dev

COPY . .

ENV PORT=4000
EXPOSE 4000

CMD ["node", "server.js"]
