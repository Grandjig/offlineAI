# Licence server for Offline AI.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
# Licences live here. Mount a volume at /data so they survive restarts.
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]
