FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=optional

COPY . .

RUN chmod +x docker/entrypoint.sh

EXPOSE 8787

ENTRYPOINT ["./docker/entrypoint.sh"]