FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY docs ./docs
EXPOSE 4000
CMD ["node", "src/server.js"]
