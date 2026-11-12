FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs upstream-https.mjs document-extraction.mjs prompt.txt ./
COPY public/ ./public/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000 BOT_CHANNEL=PROTOTYPE
USER node
EXPOSE 10000
CMD ["npm", "start"]
