# Folio backend — runs via tsx (no build step). Self-migrates on boot.
FROM node:22-slim

WORKDIR /app

# Install all deps (tsx/typescript are needed at runtime) before setting prod.
COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start"]
