FROM python:3.12-alpine

RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY app.py /app/app.py

USER 1000:1000
EXPOSE 8080
CMD ["python", "/app/app.py"]
