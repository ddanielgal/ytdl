# Stage 1: Install production dependencies
FROM node:20 AS dependencies

WORKDIR /app

RUN mkdir -p /app/bin
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /app/bin/yt-dlp
RUN chmod a+rx /app/bin/yt-dlp

# Copy only the package.json and package-lock.json
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --only=production

# Stage 2: Build the runtime image
FROM node:20 AS runner

WORKDIR /app

# Copy the built application and production dependencies
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/bin/yt-dlp ./bin/yt-dlp
COPY .next/ ./.next/
COPY next.config.mjs ./next.config.mjs
COPY package.json ./package.json

RUN apt-get update && apt-get install -y ffmpeg

# Set the NODE_ENV environment variable to production
ENV NODE_ENV production

# Expose the port the app runs on
EXPOSE 3000

# Start the Next.js application
CMD ["npm", "start"]
