# === frontend build ===
FROM node:20-slim AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY frontend ./
RUN npm run build

# === runtime ===
FROM python:3.11-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fontconfig fonts-dejavu fonts-liberation fonts-noto-core \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*
# Curated font bundle defined in fonts/manifest.json. build.sh downloads each
# entry from github.com/google/fonts and copies anything in fonts/custom/
# alongside, then refreshes fontconfig so Chromium + ffmpeg pick them up.
COPY fonts /opt/cutstorm/fonts-src
RUN chmod +x /opt/cutstorm/fonts-src/build.sh \
    && /opt/cutstorm/fonts-src/build.sh /usr/share/fonts/cutstorm
WORKDIR /app
# Install Python deps in a layer that ONLY depends on pyproject.toml.
# A stub `app/__init__.py` keeps setuptools happy without invalidating the
# layer when real source code changes — the real app/ is copied below.
COPY backend/pyproject.toml ./
RUN --mount=type=cache,id=cutstorm-pip,target=/root/.cache/pip \
    mkdir -p app && touch app/__init__.py \
    && pip install -e . \
    && rm -rf app
# Headless Chromium for the renderer pipeline. `--with-deps` installs libnss3
# & friends via apt; chromium binary lands under /root/.cache/ms-playwright.
RUN playwright install --with-deps chromium
COPY backend/app ./app
COPY --from=frontend /fe/dist ./static
ENV MODELS_DIR=/data/models \
    UPLOADS_DIR=/data/uploads \
    OUTPUTS_DIR=/data/outputs \
    STATIC_DIR=/app/static \
    FONTS_DIR=/usr/share/fonts/cutstorm \
    FONTS_MANIFEST=/opt/cutstorm/fonts-src/manifest.json \
    PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# === test stage ===
FROM runtime AS test
RUN pip install --no-cache-dir -e ".[test]"
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm && rm -rf /var/lib/apt/lists/*
COPY frontend/package.json frontend/package-lock.json* /fe/
RUN cd /fe && (if [ -f package-lock.json ]; then npm ci; else npm install; fi) \
    && npx playwright install --with-deps chromium
COPY frontend /fe/
COPY backend/tests ./tests
COPY scripts /scripts
RUN chmod +x /scripts/*.sh
WORKDIR /app
