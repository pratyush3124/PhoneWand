# Web app (landing page, demos, relay). Deploy anywhere that gives you HTTPS
# (Render, Fly.io, Railway, Cloud Run...): phones need HTTPS for motion sensors.
#   docker build -t phonewand . && docker run -p 8080:8080 phonewand
# Desktop builds placed in downloads/ before building are offered on the landing page.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY server.js relay.js ./
COPY public ./public
COPY downloads ./downloads
USER node
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["node", "server.js"]
