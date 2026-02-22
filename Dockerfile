FROM node:24.13.0-alpine AS ui-builder

RUN mkdir /app \
    && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml /app/

RUN apk add --update --no-cache g++ make git \
    && pnpm install --frozen-lockfile \
    && apk del g++ make

COPY . /app

RUN pnpm run build

FROM nginx:1.29.4-alpine
COPY  --from=ui-builder /app/dist /etc/nginx/html
COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template
RUN apk add --no-cache gettext
EXPOSE 80
CMD ["/bin/sh", "-c", "envsubst '$CONTROL_PLANE_BASE_URL $CONTROL_PLANE_ADMIN_TOKEN' < /etc/nginx/templates/nginx.conf.template > /etc/nginx/nginx.conf && nginx"]
