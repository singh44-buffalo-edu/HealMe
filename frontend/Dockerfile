FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Vite env vars are baked at build time. Defaults point at the host-mapped
# Medplum server and AI service ports; override with --build-arg for other hosts.
ARG VITE_MEDPLUM_BASE_URL=http://localhost:8103/
ARG VITE_AI_SERVICE_URL=http://localhost:8000/
ENV VITE_MEDPLUM_BASE_URL=$VITE_MEDPLUM_BASE_URL \
    VITE_AI_SERVICE_URL=$VITE_AI_SERVICE_URL

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
