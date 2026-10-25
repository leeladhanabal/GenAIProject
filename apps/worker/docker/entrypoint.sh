#!/bin/sh
set -eu

# Initial root capabilities are used only in this network namespace. There is
# no Docker socket, host networking, or control-plane credential in the image.
case "${RUN_TARGET_IP:-}" in ''|*[!0-9.]*) exit 70 ;; esac
case "${RUN_WALL_SECONDS:-}" in ''|*[!0-9]*) exit 70 ;; esac
iptables -w -P OUTPUT DROP
iptables -w -F OUTPUT
iptables -w -A OUTPUT -p tcp -d "$RUN_TARGET_IP/32" --dport 443 -j ACCEPT

# DNS is pinned by the trusted runtime wrapper; no DNS egress is permitted.
# Drop root and every capability before starting both watchdog and k6.
exec setpriv --reuid=10001 --regid=10001 --clear-groups \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  timeout --signal=TERM --kill-after=2 "${RUN_WALL_SECONDS}s" \
  /usr/bin/k6 run --no-usage-report --no-color --quiet \
  --include-system-env-vars=false --address=127.0.0.1:6565 \
  --out json=/output/results.ndjson /work/runtime.js
