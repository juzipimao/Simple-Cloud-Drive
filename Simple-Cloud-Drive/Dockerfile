# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm ci

COPY server ./server
COPY public ./public

ENV PORT=8089
EXPOSE 8089

CMD ["npm", "start"]


