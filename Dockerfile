# Multi-stage Dockerfile for Reactive Sentinel Omni (Contracts + Frontend)
FROM node:22-alpine AS contracts-test
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY hardhat.config.js ./
COPY contracts ./contracts
COPY test ./test
COPY scripts ./scripts
RUN npx hardhat compile && npx hardhat test

FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend ./
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=frontend-build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
