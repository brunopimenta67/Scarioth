#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ROOT_DIR"

MODE="docker"
if [ "$#" -gt 0 ]; then
  case "$1" in
    --docker)
      MODE="docker"
      ;;
    --dev)
      MODE="dev"
      ;;
    -h|--help)
      cat <<'EOF'
Scarioth — Setup Universal para Linux

Uso:
  ./scripts/setup-linux.sh [--docker | --dev | --help]

Modos:
  --docker  (Padrão) Sobe Redis, MongoDB e o próprio Scarioth em containers Linux
            via Docker/Podman Compose. Não exige Node.js instalado na máquina.
  --dev     Prepara ambiente de desenvolvimento nativo (cria .env, instala pacotes
            npm e sobe apenas Redis + MongoDB no Docker/Podman). Exige Node.js 20+.
  --help    Exibe esta ajuda.
EOF
      exit 0
      ;;
    *)
      echo "[ERRO] Opção desconhecida: $1" >&2
      echo "Use --help para ver as opções disponíveis." >&2
      exit 1
      ;;
  esac
fi

DISTRO_NAME="Linux"
DISTRO_ID="unknown"
DISTRO_LIKE=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_NAME="${PRETTY_NAME:-Linux}"
  DISTRO_ID="${ID:-unknown}"
  DISTRO_LIKE="${ID_LIKE:-}"
fi

echo "=== Scarioth — Setup Linux ($DISTRO_NAME) ==="

COMPOSE_BIN=""
COMPOSE_SUB=""
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_BIN="docker"
  COMPOSE_SUB="compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_BIN="docker-compose"
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
  COMPOSE_BIN="podman"
  COMPOSE_SUB="compose"
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE_BIN="podman-compose"
fi

if [ -z "$COMPOSE_BIN" ]; then
  echo "[ERRO] Docker Compose ou Podman Compose não encontrado nesta distribuição ($DISTRO_NAME)." >&2
  echo "" >&2
  case " $DISTRO_ID $DISTRO_LIKE " in
    *ubuntu*|*debian*|*mint*|*pop*)
      echo "Instale em Debian/Ubuntu/Mint/Pop!_OS:" >&2
      echo "  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2" >&2
      echo "  sudo systemctl enable --now docker && sudo usermod -aG docker \"\$USER\"" >&2
      ;;
    *fedora*|*rhel*|*centos*|*rocky*|*almalinux*)
      echo "Instale em Fedora/RHEL/Rocky:" >&2
      echo "  sudo dnf install -y podman podman-compose   # ou Docker Engine" >&2
      ;;
    *arch*|*manjaro*|*endeavouros*)
      echo "Instale em Arch/Manjaro:" >&2
      echo "  sudo pacman -S --needed docker docker-compose" >&2
      echo "  sudo systemctl enable --now docker && sudo usermod -aG docker \"\$USER\"" >&2
      ;;
    *suse*|*opensuse*)
      echo "Instale em openSUSE:" >&2
      echo "  sudo zypper install -y docker docker-compose" >&2
      echo "  sudo systemctl enable --now docker && sudo usermod -aG docker \"\$USER\"" >&2
      ;;
    *alpine*)
      echo "Instale em Alpine Linux:" >&2
      echo "  sudo apk add docker docker-cli-compose" >&2
      echo "  sudo rc-update add docker default && sudo service docker start" >&2
      ;;
    *)
      echo "Consulte o guia completo por distribuição em docs/LINUX.md." >&2
      ;;
  esac
  exit 1
fi

run_compose() {
  if [ -n "$COMPOSE_SUB" ]; then
    "$COMPOSE_BIN" "$COMPOSE_SUB" "$@"
  else
    "$COMPOSE_BIN" "$@"
  fi
}

echo "[1/3] Compose detectado: $COMPOSE_BIN${COMPOSE_SUB:+ $COMPOSE_SUB}"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[2/3] Arquivo .env criado a partir de .env.example."
else
  echo "[2/3] Arquivo .env existente preservado."
fi

if [ "$MODE" = "docker" ]; then
  echo "[3/3] Construindo imagem Linux e subindo stack completa (Redis + MongoDB + Scarioth)..."
  run_compose --profile full up -d --build
  echo ""
  echo "Scarioth rodando em container Linux!"
  echo "  Painel Web: http://127.0.0.1:3000"
  echo "  Health:     http://127.0.0.1:3000/health"
  echo "  Logs:       $COMPOSE_BIN${COMPOSE_SUB:+ $COMPOSE_SUB} --profile full logs -f scarioth"
  echo "  Parar:      $COMPOSE_BIN${COMPOSE_SUB:+ $COMPOSE_SUB} --profile full down"
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[ERRO] Modo --dev exige Node.js v20+ e npm instalados." >&2
  echo "Instale Node.js 20/22+ ou execute sem --dev (modo --docker) que funciona sem Node.js." >&2
  exit 1
fi

if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"; then
  echo "[ERRO] Node.js v20+ obrigatório (encontrado: $(node -v))." >&2
  exit 1
fi

echo "[3/3] Instalando dependências npm e subindo Redis + MongoDB..."
npm ci
run_compose up -d
echo ""
echo "Ambiente dev Linux pronto!"
echo "  Para iniciar o scanner: npm run start:dev"
echo "  Para rodar testes:      npm test && npm run test:integration"
echo "  Painel Web:             http://127.0.0.1:3000"
