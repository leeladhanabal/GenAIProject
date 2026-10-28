FROM grafana/k6:1.8.2 AS k6
FROM alpine:3.22
LABEL org.performance-agent.profile="phase5-k6-v1"
RUN apk add --no-cache ca-certificates iptables util-linux-misc coreutils
COPY --from=k6 /usr/bin/k6 /usr/bin/k6
COPY apps/worker/docker/entrypoint.sh /usr/local/bin/run-k6
RUN chmod 0555 /usr/local/bin/run-k6
ENV K6_NO_USAGE_REPORT=true K6_AUTO_EXTENSION_RESOLUTION=false HOME=/tmp
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/run-k6"]
