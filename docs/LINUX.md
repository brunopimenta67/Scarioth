# Guia Completo do Scarioth no Linux (Todas as Distribuições)

Este guia descreve como preparar e executar o **Scarioth** em qualquer distribuição Linux — seja **100% em containers** (sem precisar instalar Node.js localmente) ou em **modo desenvolvimento nativo**.

---

## 1. Pré-requisitos por Distribuição

Escolha sua família de distribuição e instale **Git** + **Docker Compose** (ou **Podman Compose**):

### Debian / Ubuntu / Linux Mint / Pop!_OS / Zorin
```bash
sudo apt-get update
sudo apt-get install -y git curl docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```
> *Opcional (para modo `--dev` sem container no app):* instale **Node.js 20+** via NodeSource, `nvm` ou `fnm`.

### Fedora / RHEL / Rocky Linux / AlmaLinux / CentOS Stream
Pode usar **Docker** ou **Podman** (nativo nessas distros):
```bash
# Opção A: Podman (nativo e rootless)
sudo dnf install -y git podman podman-compose

# Opção B: Docker Engine (repositório oficial Docker)
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install -y git docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```

### Arch Linux / Manjaro / EndeavourOS / CachyOS
```bash
sudo pacman -Syu --needed git docker docker-compose
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```
*(Para modo `--dev`, adicione `nodejs npm` ao comando `pacman`.)*

### openSUSE Tumbleweed / Leap
```bash
sudo zypper install -y git docker docker-compose
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
newgrp docker
```

### Alpine Linux
```bash
sudo apk add --no-cache git docker docker-cli-compose
sudo rc-update add docker default
sudo service docker start
sudo addgroup "$USER" docker
```

### Outras Distros (NixOS, Void, Gentoo, SteamOS, etc.)
Basta ter **Git** e **Docker** (ou **Podman** com `podman-compose`) habilitados no sistema. Todo o runtime do Scarioth, Redis e MongoDB roda isolado dentro dos containers definidos em [`Dockerfile`](../Dockerfile) e [`docker-compose.yml`](../docker-compose.yml).

---

## 2. Clonando o Repositório

```bash
git clone git@github.com:brunopimenta67/Scarioth.git
cd Scarioth
```
*(Ou via HTTPS: `git clone https://github.com/brunopimenta67/Scarioth.git && cd Scarioth`)*

---

## 3. Escolhendo o Modo de Execução

### Modo 1 — Universal 100% Container (Recomendado para qualquer distro)
Não exige Node.js nem TypeScript instalados na sua máquina. O `Dockerfile` multi-stage compila backend + painel web dentro de `node:22-bookworm-slim` e sobe tudo conectado em rede Docker com Redis e MongoDB.

#### Pelo script automático (detecta distro e Docker/Podman sozinho):
```bash
./scripts/setup-linux.sh --docker
```

#### Ou manualmente com Docker / Podman Compose:
```bash
cp -n .env.example .env
docker compose --profile full up -d --build
```
*(Se estiver usando Podman, troque `docker compose` por `podman compose`.)*

**Comandos do dia a dia no Modo 1:**
```bash
# Ver status e healthcheck dos 3 containers (scarioth-app, scarioth-redis, scarioth-mongodb)
docker compose --profile full ps

# Acompanhar os logs ao vivo do Scarioth
docker compose --profile full logs -f scarioth

# Parar tudo mantendo seus dados do MongoDB salvos no volume
docker compose --profile full down
```

---

### Modo 2 — Desenvolvimento Nativo no Linux (Node.js 20+ na máquina)
Ideal quando você quer editar código em `src/` ou `client/` com recarga rápida local, usando Docker apenas para **Redis** e **MongoDB**.

#### Pelo script automático:
```bash
./scripts/setup-linux.sh --dev
npm run start:dev
```

#### Ou passo a passo manual:
```bash
cp -n .env.example .env
npm ci
docker compose up -d
docker compose ps
npm run start:dev
```
*(Para hot-reload automático ao salvar arquivos TypeScript, use `npm run dev`.)*

---

### Modo 3 — Atalhos via `Makefile` ou DevContainer
Se tiver `make` instalado:
```bash
make up-full   # Sobe stack completa em containers (Modo 1)
make logs      # Acompanha os logs do container Scarioth
make dev       # Sobe apenas bancos + roda npm run start:dev (Modo 2)
make down      # Para todos os containers
make help      # Lista todos os alvos disponíveis
```

Se usar **VS Code** com a extensão *Dev Containers* (ou **GitHub Codespaces**), basta abrir a pasta do projeto e clicar em **Reopen in Container** — o arquivo [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json) já provisiona Node.js 22 e as portas `3000`, `6379` e `27017`.

---

## 4. Acessando o Scarioth e Inspecionando os Bancos

Com o sistema no ar:
- **Painel Web ao vivo:** `http://127.0.0.1:3000`
- **API de Histórico:** `http://127.0.0.1:3000/api/opportunities`
- **Boletim de Saúde:** `http://127.0.0.1:3000/health`
- **WebSocket do Painel:** `ws://127.0.0.1:3000/ws`

### Inspeção de Redis e MongoDB no Linux
- **Sem instalar ferramentas gráficas (via terminal Docker):**
  ```bash
  # Conferir chaves ativas no Redis
  docker exec scarioth-redis redis-cli keys "*"
  docker exec scarioth-redis redis-cli hgetall ticker:binance:BTCUSDT

  # Conferir oportunidades gravadas no MongoDB Time-Series
  docker exec scarioth-mongodb mongosh scarioth --quiet --eval "db.arbitrage_opportunities.countDocuments()"
  docker exec scarioth-mongodb mongosh scarioth --quiet --eval "db.arbitrage_opportunities.find().sort({timestamp:-1}).limit(5)"
  ```
- **Interfaces Gráficas (Opcional):**
  - **MongoDB Compass:** disponível oficialmente em `.deb`, `.rpm` e `.AppImage` em mongodb.com/try/download/compass (`mongodb://127.0.0.1:27017`).
  - **Redis Insight:** disponível em `.AppImage` / `.deb` em redis.io/insight (`127.0.0.1:6379`).

---

## 5. Rodando Testes no Linux

Com Node.js 20+ instalado localmente:
```bash
# Checagem de tipos (backend + front-end)
npm run typecheck

# Testes unitários offline (42 testes)
npm test

# Testes de integração contra Redis e MongoDB no Docker
docker compose up -d
npm run test:integration

# Smoke tests completos por etapa
npm run smoke:db
npm run smoke:ingestion
npm run smoke:engine
npm run smoke:persistence
npm run smoke:api
```

---

## 6. Solução de Problemas Comuns no Linux (Troubleshooting)

1. **`permission denied while trying to connect to the Docker daemon socket`**
   Seu usuário ainda não entrou no grupo `docker` na sessão atual. Execute:
   ```bash
   sudo usermod -aG docker "$USER"
   newgrp docker
   ```
   *(Ou faça logout e login novamente no sistema.)*

2. **Erro de porta já em uso (`3000`, `6379` ou `27017`)**
   Verifique o que está ocupando a porta:
   ```bash
   ss -tulpn | grep -E '3000|6379|27017'
   ```
   Se você já tiver um Redis/MongoDB nativo rodando no Linux, pare o serviço (`sudo systemctl stop redis mongod`) ou altere `PORT` no `.env`.

3. **Permissão negada ao rodar `./scripts/setup-linux.sh`**
   Garanta permissão de execução com:
   ```bash
   chmod +x scripts/setup-linux.sh
   ```

4. **Acesso de outra máquina na rede local**
   O servidor HTTP faz bind em `0.0.0.0:3000`, mas firewalls como `ufw` (Ubuntu) ou `firewalld` (Fedora) bloqueiam acessos externos por padrão. Para acesso local na própria máquina use sempre `http://127.0.0.1:3000`; se quiser liberar na rede local, abra a porta `3000/tcp` no seu firewall.
