# 📱 Hero SMS

> A lightweight, modern web application for obtaining temporary Malaysian phone numbers using the **Hero-SMS** API, created by **Pius** and designed for self-hosting on **Oracle Cloud Free Tier** or any Docker-compatible server.

[![Build & Publish Docker Image](https://github.com/Neoslyke/hero-sms/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/Neoslyke/hero-sms/actions/workflows/docker-publish.yml)
[![Docker Image](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://github.com/Neoslyke/hero-sms/pkgs/container/hero-sms)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

---

## ✨ Features

- **🇲🇾 Always Malaysia**: Locked strictly to Malaysia (`Country ID: 7`, dial code `+60`).
- **🍗 Quick-Pick Featured Services**: One-click shortcuts for top Malaysian apps: **KFC** (`fz`), **Chagee** (`bwx`), **ZUS Coffee** (`aik`), and **General** (`ot`).
- **📋 "Other Services" Directory**: Searchable directory of 230+ Malaysian services (Grab, WhatsApp, Shopee, Telegram, etc.) sorted alphabetically with live pricing (`Buy Number for {service} ($0.07)`).
- **📋 Multi-Number Active Queue & Persistence**: Real-time queue displaying all numbers currently waiting for SMS with full server-side session persistence across browser refreshes and incognito tabs.
- **🇲🇾 Local Format Copying**: One-click number copy automatically converts international format (`6011...`) into local Malaysian format (`011...`) ready for mobile apps.
- **⏱️ 20-Minute Lifecycle Management**: Real-time countdown timer with color-coded urgency and visual progress bar.
  - **Auto-Confirm**: Automatically completes activation upon timer expiry if an SMS OTP is received.
  - **Auto-Cancel & 100% Refund**: Automatically refunds funds back to your wallet if no SMS arrives within 20 minutes.
  - **Manual Cancel & Refund**: Instant refund button available at any time prior to OTP arrival.
- **💰 Live Wallet Balance**: Real-time balance badge in the header with 1-click refresh feedback, updating automatically after every order, cancellation, or confirmation.
- **⚡ Real-Time SMS Polling & Audio Alert**: Background polling every 3 seconds for incoming OTPs with a synthesized Web Audio chime on code arrival and 1-click code copying.
- **🚀 Subpath & Reverse-Proxy Ready**: Runs seamlessly under `/hero-sms` or at the root `/`.
- **🐳 Multi-Architecture Docker Image**: Prebuilt images for both `linux/amd64` and `linux/arm64` (Apple Silicon, Raspberry Pi, Oracle Cloud ARM Ampere A1).

---

## 🚀 Quick Start with Docker

### Option 1: Docker Run (Fastest)

```bash
docker run -d \
  --name hero-sms \
  -p 3001:3001 \
  -e PORT=3001 \
  -e BASE_PATH=/hero-sms \
  -e HERO_SMS_API_KEY=your_hero_sms_api_key \
  --restart unless-stopped \
  ghcr.io/neoslyke/hero-sms:latest
```

Access your app at `http://localhost:3001/hero-sms`.

### Option 2: Docker Compose

1. Clone the repository:

```bash
git clone https://github.com/Neoslyke/hero-sms.git
cd hero-sms
```

2. Configure your environment:

```bash
cp .env.example .env
# Edit .env with your HERO_SMS_API_KEY
```

3. Start the container:

```bash
docker compose up -d
```

4. Open `http://localhost:3001/hero-sms` in your browser.

---

## ☁️ Deployment Guide: Oracle Cloud Free Tier

### 1. Ingress Rule (Oracle Cloud Console)

1. In the Oracle Cloud Console, navigate to **Networking** → **Virtual Cloud Networks** → your VCN.
2. Under **Security Lists**, open the default security list.
3. Add an Ingress Rule:

- **Source CIDR**: `0.0.0.0/0`
- **IP Protocol**: `TCP`
- **Destination Port Range**: `80, 443`
- **Description**: `HTTP/HTTPS Ingress`

### 2. VM Operating System Firewall

SSH into your Oracle VM:

```bash
ssh -i /path/to/key ubuntu@<YOUR_ORACLE_VM_IP>
```

Allow the required ports through Ubuntu's internal firewall:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt-get update && sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

---

## 🔀 Running Behind a Reverse Proxy

### Caddy (Recommended)

If your server runs Caddy (e.g. from `~/projects/docker-compose.yml`):

**Step 1 — Add the service to `docker-compose.yml`:**

```yaml
  hero-sms:
    image: ghcr.io/neoslyke/hero-sms:latest
    container_name: hero-sms
    restart: unless-stopped
    expose:
      - "3001"
    env_file:
      - ./hero-sms/.env
    environment:
      - PORT=3001
      - BASE_PATH=/hero-sms
    volumes:
      - ./hero-sms/.env:/app/.env:ro
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Ensure `hero-sms` is listed under the `caddy` service's `depends_on`.

**Step 2 — Add a route to the `Caddyfile`:**

Inside your domain block (e.g. `yourdomain.com` or `your-subdomain.duckdns.org`) in `~/projects/proxy/Caddyfile`:

```caddy
    # Hero SMS Platform
    handle /hero-sms* {
        reverse_proxy hero-sms:3001
    }
```

**Step 3 — Launch and reload Caddy:**

```bash
cd ~/projects
docker compose pull hero-sms
docker compose up -d hero-sms
docker compose exec caddy caddy reload
```

### Nginx (Alternative)

If using Nginx on your server:

```nginx
    # Hero SMS Route
    location /hero-sms {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

---

## 🔄 Updating to the Latest Version

### Quick update via Docker Compose

```bash
cd ~/projects
docker compose pull hero-sms && docker compose up -d hero-sms
```

### Or using `update.sh`

```bash
bash ~/projects/update.sh
```

---

## 💻 Local Development

To run the project locally without Docker:

```bash
# 1. Install dependencies
npm install

# 2. Start the development server with live reload
npm run dev

# 3. Or run the standard production start
npm start
```

Visit `http://localhost:3001` or `http://localhost:3001/hero-sms`.

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0** (GPL-3.0) — see the [LICENSE](LICENSE) file for details.
