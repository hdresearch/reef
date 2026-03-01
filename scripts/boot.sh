#!/bin/bash
# Boot script for reef golden images.
# Add to /etc/rc.local or systemd to auto-start reef on VM restore.
#
# Usage: /root/reef/scripts/boot.sh

set -e

# 1. Fix DNS (systemd-resolved loses upstream config after commit/restore)
echo "nameserver 8.8.8.8" > /etc/resolv.conf

# 2. Ensure PATH
export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# 3. Source reef env
cd /root/reef
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# 4. Kill stale reef
pkill -f "bun run src/main" 2>/dev/null || true
sleep 1

# 5. Start reef
nohup bun run src/main.ts > /tmp/reef.log 2>&1 &
REEF_PID=$!

# 6. Health check (up to 30s)
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "reef up (PID $REEF_PID) in ${i}s"
    exit 0
  fi
  sleep 1
done

echo "reef failed to start"
tail -20 /tmp/reef.log
exit 1
