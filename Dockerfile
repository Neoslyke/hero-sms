# Use lightweight Node Alpine image for low memory usage (ideal for Oracle Free Tier)
FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts

# Copy application source
COPY server.js ./
COPY public/ ./public/

# Default environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV BASE_PATH=/hero-sms

EXPOSE 3001

CMD ["node", "server.js"]
