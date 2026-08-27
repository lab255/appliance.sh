#!/bin/sh
set -u

httpd -f -p 3000 -h /www &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' TERM INT
status=0
wait "$child" || status=$?
exit "$status"
