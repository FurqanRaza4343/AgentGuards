# One image, one process: the scanner (FastAPI) also serves the built site, so the page and /api share an origin
# and the Content-Security-Policy can stay `connect-src 'self'`.
#
#   docker build -t agentguard .
#   docker run --rm -p 8080:8080 --read-only --cap-drop ALL -e GEMINI_API_KEY=... agentguard
#
# Hardening notes (the pattern follows the Obscura project's Dockerfile, which explains why a process that reads
# untrusted input should not run as root):
#   - the scanner reads untrusted repositories, so it runs as a non-root user with a read-only root filesystem;
#   - it never writes to disk: archives are read in memory, and nothing from a repository is ever executed;
#   - the build stage is thrown away, so Node and the sources are not in the final image.

# ---- 1. build the site ----
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- 2. the scanner and the site ----
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    AGENTGUARD_ENV=production \
    AGENTGUARD_STATIC_DIR=/srv/site \
    PORT=8080
WORKDIR /srv

COPY server/requirements.txt ./requirements.txt
RUN pip install -r requirements.txt

COPY server/guardscan ./guardscan
COPY server/demo ./demo
COPY --from=web /app/dist /srv/site

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin agentguard
USER 10001

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT','8080'), timeout=3)"

# Cloud Run sends the real client address in X-Forwarded-For: set AGENTGUARD_TRUST_PROXY=1 there (not here, because
# anyone can forge that header when nothing in front of the container strips it).
CMD ["sh", "-c", "exec uvicorn guardscan.api:app --host 0.0.0.0 --port ${PORT} --no-server-header"]
