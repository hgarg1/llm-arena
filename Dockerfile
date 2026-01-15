# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built assets and necessary files from build stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/views ./views
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

# Ensure entrypoint is executable
RUN chmod +x /app/scripts/docker-entrypoint.sh

# Document internal port
EXPOSE 3000

# Start sequence: entrypoint handles migrations/waiting for DB, CMD starts the server
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["npm", "start"]