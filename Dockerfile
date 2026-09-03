FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --include=optional --no-audit --no-fund

COPY . .

RUN chmod +x docker/entrypoint.sh

EXPOSE 8787

ENTRYPOINT ["./docker/entrypoint.sh"]