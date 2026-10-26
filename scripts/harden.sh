#!/usr/bin/env bash
# Host hardening for morganpi before it faces the internet (80/443 forwarded).
# Run as root:  sudo bash scripts/harden.sh
set -euo pipefail

LAN=192.168.1.0/24

echo "== 1/4 SSH: key-only, no root, james only =="
install -m 644 /dev/stdin /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin no
AllowUsers james
MaxAuthTries 4
EOF
sshd -t                       # abort (set -e) rather than apply a broken config
systemctl reload ssh
echo "   sshd reloaded (existing sessions unaffected)"

echo "== 2/4 Disable rpcbind (port 111) =="
systemctl disable --now rpcbind.socket rpcbind.service 2>/dev/null || true

echo "== 3/4 Firewall: deny in; allow 80/443 anywhere, 22 from LAN only =="
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq ufw fail2ban unattended-upgrades
# NOTE: Docker-published ports (8086) bypass ufw; 8086 stays internet-safe
# because the router forwards only 80/443 to this host.
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow from "$LAN" to any port 22 proto tcp comment 'ssh LAN only'
ufw allow 80/tcp  comment 'caddy http->https'
ufw allow 443/tcp comment 'caddy https'
ufw --force enable
ufw status verbose

echo "== 4/4 fail2ban + unattended upgrades =="
install -m 644 /dev/stdin /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

install -m 644 /dev/stdin /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades

echo
echo "Done. Verify from another LAN machine BEFORE closing this session:"
echo "  ssh james@192.168.1.232   (key auth must still work)"
