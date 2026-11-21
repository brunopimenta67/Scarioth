SHELL := /bin/sh

COMPOSE := $(shell if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then echo "docker compose"; elif command -v docker-compose >/dev/null 2>&1; then echo "docker-compose"; elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then echo "podman compose"; elif command -v podman-compose >/dev/null 2>&1; then echo "podman-compose"; fi)

.PHONY: help env up-full up-db down logs dev build test test-integration typecheck

help:
	@echo "Comandos disponíveis para o Scarioth (Linux/Unix):"
	@echo "  make env               Cria .env a partir de .env.example se não existir"
	@echo "  make up-full           Sobe Redis + MongoDB + Scarioth em container (sem exigir Node local)"
	@echo "  make up-db             Sobe apenas Redis e MongoDB via Docker/Podman"
	@echo "  make down              Para todos os containers do projeto"
	@echo "  make logs              Acompanha os logs do container Scarioth"
	@echo "  make dev               Prepara .env, sobe bancos e inicia o Scarioth em modo dev local"
	@echo "  make build             Compila backend (dist/) e painel (public/)"
	@echo "  make typecheck         Valida tipos TypeScript do backend e do painel"
	@echo "  make test              Executa testes unitários offline"
	@echo "  make test-integration  Executa testes de integração contra Redis e MongoDB"

env:
	@if [ ! -f .env ]; then cp .env.example .env && echo ".env criado a partir de .env.example"; fi

up-full: env
	@test -n "$(COMPOSE)" || (echo "Docker Compose ou Podman Compose não encontrado." && exit 1)
	$(COMPOSE) --profile full up -d --build

up-db: env
	@test -n "$(COMPOSE)" || (echo "Docker Compose ou Podman Compose não encontrado." && exit 1)
	$(COMPOSE) up -d

down:
	@test -n "$(COMPOSE)" || (echo "Docker Compose ou Podman Compose não encontrado." && exit 1)
	$(COMPOSE) --profile full down

logs:
	@test -n "$(COMPOSE)" || (echo "Docker Compose ou Podman Compose não encontrado." && exit 1)
	$(COMPOSE) --profile full logs -f scarioth

dev: up-db
	npm run start:dev

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

test-integration:
	npm run test:integration
