# ---------- зависимости ----------
FROM node:22-alpine AS deps
WORKDIR /app
# Только манифест: слой с зависимостями кэшируется, пока package.json не менялся.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# ---------- запуск ----------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
# Amvera завершает TLS у себя и проксирует на этот порт (см. containerPort в amvera.yml).
ENV PORT=80

COPY --from=deps /app/node_modules ./node_modules
COPY relay.js ./
COPY public ./public

EXPOSE 80

# PASSWORD и AGENT_KEY задаются переменными окружения в кабинете Amvera (секреты),
# в образ их не зашиваем.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay.js"]
