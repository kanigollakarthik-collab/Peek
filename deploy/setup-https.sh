#!/usr/bin/env bash
# Puts Peek behind HTTPS with Caddy (free, automatic Let's Encrypt certificates).
# Needs a domain name pointing at this server, e.g. a free DuckDNS subdomain.
# Run on the server from the repo root:  bash deploy/setup-https.sh peek-yourname.duckdns.org
set -euo pipefail

DOMAIN="${1:?usage: bash deploy/setup-https.sh <domain>}"
PORT="${PORT:-8080}"

echo "== install Caddy =="
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y caddy
fi

echo "== Caddyfile for $DOMAIN =="
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT {
		# Answers stream back one product at a time: pass each line on immediately.
		flush_interval -1
	}
}
EOF
sudo systemctl enable --now caddy
sudo systemctl reload caddy

echo "== open ports 80 and 443 in the OS firewall =="
for p in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 5 -p tcp --dport "$p" -j ACCEPT
  fi
done
sudo netfilter-persistent save

echo "== app listens on localhost only (reachable through HTTPS only) =="
if grep -q '^HOST=' server/.env; then
  sed -i 's/^HOST=.*/HOST=127.0.0.1/' server/.env
else
  echo 'HOST=127.0.0.1' >> server/.env
fi
pm2 restart peek --update-env

echo
echo "Done. Also add Ingress rules for TCP 80 and 443 (source 0.0.0.0/0) in the"
echo "instance's VCN security list, then check: curl https://$DOMAIN/api/health"
echo "Put https://$DOMAIN in extension/src/settings.js (PEEK_SERVER_URL)."
