FROM node:22.23.3-alpine AS renderer

WORKDIR /build
COPY jassub/package.json jassub/package-lock.json jassub/build.sh jassub/fonts.sha256 ./
RUN npm ci --no-audit --no-fund && sh build.sh /out

FROM python:3.12-alpine

RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=renderer /out /app/jassub
COPY app.py /app/app.py

USER 1000:1000
EXPOSE 8080
CMD ["python", "/app/app.py"]
