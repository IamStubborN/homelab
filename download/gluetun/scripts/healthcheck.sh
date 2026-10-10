#!/bin/sh

# Query Gluetun's native VPN health monitor, which checks multiple targets
# and performs tunnel recovery. Keep application health independent.
exec /gluetun-entrypoint healthcheck
