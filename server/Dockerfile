# ── Бэкенд аптеки (NestJS + Prisma) для Railway ──
# Node 22 (LTS). На 18-й ветке обновления безопасности прекратились в апреле 2025:
# каждая новая дыра в самой платформе так и оставалась бы в сервере аптеки.
FROM node:22-slim

# openssl нужен движку Prisma
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Сначала то, что нужно установке: манифесты, обе схемы Prisma и scripts/ —
# postinstall запускает scripts/generate.mjs, и без этой папки установка упадёт
COPY package*.json ./
COPY prisma ./prisma
COPY scripts ./scripts
RUN npm install

# Остальные исходники + сборка Nest -> dist/main.js
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Схему базы приводит в порядок сам сервер при старте (см. syncSchema в src/main.ts),
# поэтому здесь только запуск. Так это работает и когда платформа подменяет команду
# запуска своей — а Railway это умеет.
CMD ["node", "dist/main"]
