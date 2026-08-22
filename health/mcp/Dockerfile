# syntax=docker/dockerfile:1
ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134
FROM ${PYTHON_IMAGE}

RUN groupadd --gid 10000 health \
 && useradd --uid 10000 --gid 10000 --create-home --home-dir /app \
      --shell /usr/sbin/nologin health

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY health_mcp /app/health_mcp
COPY assets /app/assets

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MPLCONFIGDIR=/tmp/matplotlib \
    XDG_CACHE_HOME=/tmp \
    HOME=/tmp

USER 10000:10000
EXPOSE 8080
CMD ["python", "-m", "health_mcp.server"]
