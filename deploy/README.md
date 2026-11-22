# Deploying AgentGuard on a VPS

This is how the project runs on the Contabo VPS that also hosts other projects (each in its own `/opt/<name>` folder,
behind one shared Caddy in `/opt/proxy`).

```
/opt/agentguard/
  app/       a clone of this repository
  .env       secrets (mode 600): GEMINI_API_KEY, GEMINI_API_KEY2, SEARXNG_SECRET
/opt/proxy/sites/agentguard.caddy      the domain and HTTPS (a copy of deploy/agentguard.caddy)
```

## First deploy

```bash
sudo mkdir -p /opt/agentguard && sudo chown "$USER": /opt/agentguard && cd /opt/agentguard
git clone https://github.com/FurqanRaza4343/AgentGuards.git app
umask 077 && printf 'SEARXNG_SECRET=%s\nGEMINI_API_KEY=...\n' "$(openssl rand -hex 32)" > .env     # add GEMINI_API_KEY2 too if you have it
cd app && docker compose -f deploy/docker-compose.prod.yml --env-file ../.env up -d --build
curl -s http://127.0.0.1:8280/api/health                                                             # {"ok":true,...}

cp deploy/agentguard.caddy /opt/proxy/sites/agentguard.caddy
docker exec proxy-caddy caddy validate --config /etc/caddy/Caddyfile                                  # never restart with a config that fails this
docker restart proxy-caddy                                                                            # the proxy has `admin off`, so a restart is its reload
```

HTTPS is automatic: Caddy gets a certificate for the domain on its first request. `NAME.IP-WITH-DASHES.sslip.io` resolves to
that IP, so no DNS record is needed.

## Update

```bash
cd /opt/agentguard/app && git pull && docker compose -f deploy/docker-compose.prod.yml --env-file ../.env up -d --build
```

## What keeps a public service safe next to other projects

- It listens on `127.0.0.1` only; the proxy is the only way in. SearXNG publishes no port.
- The container is read-only, non-root, with all capabilities dropped, and limited to 1 GB of memory, 1.5 CPUs and 256 processes.
- The service refuses private and loopback addresses and every address it resolves to one (the other projects' databases and
  dashboards on this machine are exactly that), checks every redirect, and reads a given website only a few times an hour.
- Per-address rate limit (6 runs an hour), a daily cap on model calls (150), and a kill switch: set `AGENTGUARD_KILL_SWITCH=1` in `.env`
  and run the `up -d` command again to switch the model off at once.

## Stop or remove

```bash
cd /opt/agentguard/app && docker compose -f deploy/docker-compose.prod.yml --env-file ../.env down      # stop (keeps the folder)
sudo rm /opt/proxy/sites/agentguard.caddy && docker restart proxy-caddy                                    # remove the domain
```
