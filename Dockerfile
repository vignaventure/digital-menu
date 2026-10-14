FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# Database + uploaded images live here: mount a persistent volume.
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
