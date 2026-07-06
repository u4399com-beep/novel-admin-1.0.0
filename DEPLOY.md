# ============================================================
# Novel Management System - Docker Deployment Guide
# ============================================================

## Overview

This is a production-ready Docker deployment for the Novel Management System (小说管理系统).
The system consists of:

- **Next.js 16 App** (Port 3000) - Main web application with React frontend
- **Scraper Service** (Port 3099) - Background web scraping engine (internal)
- **SQLite Database** - Persistent data storage via Prisma ORM

Both services run inside a single container, managed by an entrypoint script with graceful shutdown support.

---

## Prerequisites

| Requirement | Minimum Version |
|-------------|----------------|
| Docker      | 20.10+          |
| Docker Compose | 2.0+ (or docker-compose 1.29+) |
| Available Disk Space | 2GB+ (for image + data) |
| Available RAM  | 512MB+          |
| OS          | Linux / macOS / Windows (with WSL2) |

---

## Quick Start (5 Minutes)

### Step 1: Clone / Copy Project Files

```bash
# If using git:
git clone <your-repo-url> novel-manager
cd novel-manager

# Or copy the project directory to your server
scp -r ./novel-manager user@server:/opt/novel-manager
ssh user@server
cd /opt/novel-manager
```

### Step 2: Configure Environment (Optional)

```bash
# Copy the example environment file
cp .env.example .env

# Edit environment variables (optional - defaults work out of the box)
nano .env
```

Available environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_PORT` | `3000` | Host port to expose the application |
| `APP_NAME` | `小说管理系统` | Application display name |
| `APP_URL` | `http://localhost:3000` | Public URL of the application |
| `DATABASE_URL` | `file:/app/data/db/custom.db` | SQLite database path (inside container) |
| `SCRAPER_SERVICE_URL` | `http://localhost:3099` | Scraper service URL (internal) |

### Step 3: Build Docker Image

```bash
# Build using Docker Compose (recommended)
docker compose build

# Or build directly with Docker
docker build -t novel-manager:latest .
```

> **Note:** First build may take 5-10 minutes due to dependency installation and Next.js compilation.

### Step 4: Start the Application

```bash
# Start in detached mode (background)
docker compose up -d

# View logs
docker compose logs -f
```

### Step 5: Verify Deployment

```bash
# Check container status
docker compose ps

# Test health endpoint
curl http://localhost:3000/api/health

# Expected response:
# {"status":"healthy","services":{"database":{"status":"connected","latencyMs":<number>}}}
```

Open your browser and navigate to: **http://localhost:3000** (or your configured port)

---

## Production Deployment

### Deploying to a Linux Server

#### 1. Install Docker on the Server

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for group change to take effect
```

#### 2. Upload Project Files

```bash
# From your local machine
rsync -avz --exclude=node_modules --exclude=.next --exclude=.git \
  ./novel-manager/ user@your-server:/opt/novel-manager/
```

#### 3. Build and Start

```bash
cd /opt/novel-manager

# Build the image
docker compose build --no-cache

# Start the service
docker compose up -d
```

#### 4. Configure Reverse Proxy (Nginx Example)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
```

#### 5. Enable HTTPS with Let's Encrypt (Optional)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### Running on a Custom Port

```bash
# Method 1: Environment variable
APP_PORT=8080 docker compose up -d

# Method 2: Edit .env file
echo "APP_PORT=8080" >> .env
docker compose up -d
```

---

## Common Operations

### View Logs

```bash
# Follow all logs
docker compose logs -f

# Follow only app logs (filter)
docker compose logs -f | grep "\[App\]"

# Follow only scraper logs
docker compose logs -f | grep "\[Scraper\]"

# Last 100 lines
docker compose logs --tail=100
```

### Restart Services

```bash
# Graceful restart
docker compose restart

# Full rebuild and restart
docker compose up -d --build
```

### Stop Services

```bash
# Stop (preserve data)
docker compose stop

# Stop and remove container (data preserved in volume)
docker compose down

# Stop and remove data volume (WARNING: deletes all data)
docker compose down -v
```

### Update to New Version

```bash
# Pull latest code (if using git)
git pull origin main

# Rebuild and restart with zero downtime
docker compose build
docker compose up -d --build
```

### Backup Data

```bash
# Backup the SQLite database
docker cp novel-manager:/app/data/db/custom.db ./backup-$(date +%Y%m%d).db

# Backup the entire data volume
docker run --rm -v novel-manager_novel-data:/data -v $(pwd):/backup \
  alpine tar czf /backup/novel-data-backup-$(date +%Y%m%d).tar.gz /data
```

### Restore Data

```bash
# Stop the service first
docker compose stop

# Restore the database file
docker cp ./backup-20250101.db novel-manager:/app/data/db/custom.db

# Start the service
docker compose start
```

### Access the Container Shell (Debugging)

```bash
# Enter as root (for debugging only)
docker compose exec --user root novel-manager sh

# Check database
docker compose exec novel-manager sh -c "ls -la /app/data/db/"

# Check running processes
docker compose exec novel-manager sh -c "ps aux"

# Check disk usage
docker compose exec novel-manager sh -c "du -sh /app/data/*"
```

---

## Troubleshooting

### Container won't start

```bash
# Check logs for errors
docker compose logs

# Common causes:
# 1. Port 3000 already in use → Change APP_PORT
# 2. Insufficient memory → Increase Docker memory limit
# 3. Build failed → Run `docker compose build --no-cache` for clean build
```

### Health check failing

```bash
# Check if the app is actually responding
docker compose exec novel-manager curl -f http://localhost:3000/api/health

# If curl is not available inside container (shouldn't happen with current Dockerfile):
docker compose exec novel-manager sh -c "wget -qO- http://localhost:3000/api/health"

# Check if port is bound
docker compose exec novel-manager sh -c "netstat -tlnp | grep 3000"
```

### Database errors

```bash
# Check database file exists
docker compose exec novel-manager ls -la /app/data/db/

# Reinitialize database (WARNING: deletes all data)
docker compose stop
docker compose exec novel-manager rm -f /app/data/db/custom.db
docker compose start
```

### Scraper service not working

```bash
# Check scraper logs
docker compose logs | grep "\[Scraper\]"

# Check if scraper process is running
docker compose exec novel-manager sh -c "ps aux | grep 'bun index'"

# Restart just the container (both services restart together)
docker compose restart
```

### Out of disk space

```bash
# Check Docker disk usage
docker system df

# Clean up unused images/containers/volumes
docker system prune -a

# Check data volume size
docker run --rm -v novel-manager_novel-data:/data alpine du -sh /data/*
```

---

## Architecture Details

```
┌──────────────────────────────────────────────┐
│              Docker Container                │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  docker-entrypoint.sh (PID 1)        │   │
│  │  ├─ Next.js Server (Port 3000)       │   │
│  │  └─ Scraper Service (Port 3099)      │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  /app/data/db/custom.db (SQLite)     │   │
│  │  /app/data/covers/ (Cover images)    │   │
│  │  /app/data/downloads/ (Downloads)    │   │
│  └──────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
         │
         │ Port 3000
         ▼
   Host / Reverse Proxy
```

### Multi-Stage Build Stages

| Stage | Purpose | Base Image |
|-------|---------|------------|
| `base` | Common base | `oven/bun:1` |
| `deps` | Install npm dependencies | `base` |
| `builder` | Build Next.js + Prisma | `base` |
| `scraper-builder` | Build scraper service | `oven/bun:1` |
| `runner` | Production runtime | `oven/bun:1` |

### Security Features

- Non-root user (`nextjs:nodejs`, UID/GID 1001)
- Security headers (X-Frame-Options, X-Content-Type-Options, etc.)
- Removed `X-Powered-By` header
- Input validation on all API endpoints
- No `ignoreBuildErrors` in production build

---

## File Structure (Production Container)

```
/app/
├── .next/
│   ├── standalone/          # Next.js standalone server
│   └── static/              # Static assets
├── public/                  # Public static files
├── prisma/
│   └── schema.prisma        # Database schema
├── scraper-service/
│   ├── index.ts             # Scraper service entry
│   ├── package.json
│   └── node_modules/        # Scraper dependencies
├── node_modules/
│   ├── .prisma/             # Generated Prisma client
│   ├── @prisma/             # Prisma engine
│   └── prisma/              # Prisma CLI
├── data/
│   ├── db/custom.db         # SQLite database
│   ├── covers/              # Cover images
│   ├── downloads/           # Downloaded files
│   └── chapters/            # Chapter files
└── docker-entrypoint.sh     # Startup script
```

---

## Performance Tuning

### Docker Resource Limits

Add to `docker-compose.yml`:

```yaml
services:
  novel-manager:
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '1.0'
        reservations:
          memory: 256M
          cpus: '0.25'
```

### SQLite Optimization

For high-concurrency scenarios, consider mounting the database on a tmpfs:

```yaml
services:
  novel-manager:
    tmpfs:
      - /app/data/db
volumes:
  novel-data:  # For covers, downloads, etc. (non-db data)
```

> **Warning:** tmpfs is volatile - database data is lost on container restart.
> Use only with an external backup strategy.

---

## Version Information

- **Application Version:** 1.0.0
- **Next.js:** 16.x
- **Bun:** 1.x
- **Prisma:** 6.x
- **Node.js (via Bun):** Compatible