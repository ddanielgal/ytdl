FROM node:20

WORKDIR /app

COPY setup.sh ./
RUN chmod +x setup.sh && ./setup.sh && rm setup.sh

ENV PATH=/root/.local/bin:$PATH
ENV PATH=/opt/venv/bin:$PATH

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
