FROM node:20-alpine AS frontend-build
ARG FUND_VALUATION_BAIDU_ANALYTICS_ID=
ARG FUND_VALUATION_NPM_REGISTRY=https://registry.npmjs.org
ENV FUND_VALUATION_BAIDU_ANALYTICS_ID=${FUND_VALUATION_BAIDU_ANALYTICS_ID}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry "${FUND_VALUATION_NPM_REGISTRY}"
COPY index.html tsconfig.json tsconfig.node.json vite.config.ts ./
COPY config ./config
COPY public ./public
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine AS frontend
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html
EXPOSE 80

FROM python:3.12-slim AS backend
ARG FUND_VALUATION_PIP_INDEX_URL=https://pypi.org/simple
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    FUND_VALUATION_DATA_DIR=/app/data
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --index-url "${FUND_VALUATION_PIP_INDEX_URL}" -r requirements.txt
COPY backend ./backend
COPY config ./config
RUN mkdir -p /app/data
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "4", "--timeout", "60", "backend.wsgi:app"]
