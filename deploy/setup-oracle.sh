#!/usr/bin/env bash
# One-time setup for the Oracle Cloud micro instance (Ubuntu, x86_64, 1 GB RAM).
# Run on the server from the repo root:  bash deploy/setup-oracle.sh
set -euo pipefail

PORT="${PORT:-8080}"

echo "== swap (1 GB RAM is tight for npm install) =="
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "== Node.js 22 + PM2 =="
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo npm install -g pm2

echo "== open port $PORT in the OS firewall (Oracle images block it by default) =="
if ! sudo iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$PORT" -j ACCEPT
  sudo apt-get install -y iptables-persistent
  sudo netfilter-persistent save
fi

echo "== install and build =="
(cd server && npm ci --omit=dev)
(cd dashboard && npm ci && npm run build)

if [ ! -f server/.env ]; then
  cp server/.env.example server/.env
  echo "!! created server/.env from the example: fill in the keys, then rerun pm2"
fi

echo "== start with PM2 =="
pm2 startOrReload deploy/ecosystem.config.cjs
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" | tail -n 1 | bash || true

echo
echo "Done. Also add an Ingress rule for TCP $PORT in the instance's VCN security list"
echo "(Oracle console > Networking > Virtual cloud networks > Security lists)."
echo "Check: curl http://<public-ip>:$PORT/api/health"
