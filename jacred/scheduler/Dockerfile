FROM alpine:3.22

RUN apk add --no-cache bash ca-certificates curl tzdata util-linux

COPY run-job.sh /usr/local/bin/run-job.sh
COPY rotate-jacred-logs.sh /usr/local/bin/rotate-jacred-logs.sh
COPY crontab /etc/crontabs/root
RUN chmod 0755 /usr/local/bin/run-job.sh /usr/local/bin/rotate-jacred-logs.sh

ENTRYPOINT ["crond", "-f", "-l", "2"]
