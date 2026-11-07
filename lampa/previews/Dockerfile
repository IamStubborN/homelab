FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg mesa-va-drivers ca-certificates && \
    if [ "$(dpkg --print-architecture)" = amd64 ]; then apt-get install -y --no-install-recommends intel-media-va-driver; fi && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.py /app/app.py
USER 1000:1000
EXPOSE 8080
CMD ["python", "/app/app.py"]
