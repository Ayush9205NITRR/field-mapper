# Works on Fly.io, Cloud Run, Railway, or any Docker host.
FROM node:22-alpine

WORKDIR /app

# Install dependencies first so this layer caches across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Run as the image's non-root user.
USER node

CMD ["npm", "start"]
