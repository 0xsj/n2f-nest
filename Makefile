.DEFAULT_GOAL := help
SHELL := /bin/sh

BUN ?= bun
N2F_POSTGRES_PORT ?= 7220
N2F_NATS_PORT ?= 7222
N2F_NATS_MONITOR_PORT ?= 7223
N2F_DATABASE_URL ?= postgres://n2f:n2f_local@127.0.0.1:$(N2F_POSTGRES_PORT)/n2f
N2F_NATS_URL ?= nats://127.0.0.1:$(N2F_NATS_PORT)
COMPOSE ?= docker compose -f compose.yaml

export N2F_POSTGRES_PORT N2F_NATS_PORT N2F_NATS_MONITOR_PORT N2F_DATABASE_URL N2F_NATS_URL
DURABLE = N2F_DATABASE_URL=$(N2F_DATABASE_URL) N2F_NATS_URL=$(N2F_NATS_URL) \
	N2F_NATS_STREAM=n2f_events N2F_NATS_SUBJECT_PREFIX=n2f.events.
MEMORY_SUITES = N2F_RUN_IDENTITY_INTEGRATION=1 N2F_RUN_ORGANIZATION_INTEGRATION=1 N2F_RUN_CHAOS_INTEGRATION=1
MEMORY_SPECS = test/identity.integration.spec.ts test/organization.integration.spec.ts test/chaos.integration.spec.ts
MEMORY_SUITES += N2F_RUN_DOCUMENT_PROCESSING_INTEGRATION=1 # example
MEMORY_SPECS += test/document-processing.integration.spec.ts # example

.PHONY: help install build lint test check audit infra-up infra-down \
	test-memory test-postgres test-nats test-recovery test-audit-redelivery \
	test-restart test-rate-limit-cluster test-e2e test-durable ci mutation fork-check

help: ## List targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-24s %s\n", $$1, $$2}'

install: ## Install dependencies exactly as locked
	$(BUN) install --frozen-lockfile

build: ## Compile
	$(BUN) run build

lint: ## Architecture checks and oxlint
	$(BUN) run lint

test: ## Unit tests and infrastructure-free suites
	$(BUN) run test

check: build lint test ## Build, lint and test without infrastructure

audit: ## Fail on known-vulnerable dependencies
	$(BUN) audit

infra-up: ## Start PostgreSQL and NATS (compose.yaml) and wait for health
	$(COMPOSE) up -d --wait

infra-down: ## Remove the test infrastructure and its data
	$(COMPOSE) down -v

test-memory: ## In-memory integration suites (identity, organization, workflow, chaos)
	$(MEMORY_SUITES) $(BUN) x vitest run $(MEMORY_SPECS)

test-postgres: ## PostgreSQL suite and every adapter contract
	$(DURABLE) $(BUN) run test:postgres

test-nats: ## PostgreSQL + NATS JetStream suites
	$(DURABLE) $(BUN) run test:nats

test-recovery: ## Outbox recovery from an ambiguous publish
	$(DURABLE) $(BUN) run test:recovery

test-audit-redelivery: ## Audit idempotency under JetStream redelivery
	$(DURABLE) $(BUN) run test:audit-redelivery

test-restart: build ## Durable state across a process restart
	$(DURABLE) N2F_RESTART_PORT=7301 $(BUN) run test:restart

test-rate-limit-cluster: build ## Shared rate limits across two processes
	$(DURABLE) N2F_RATE_LIMIT_PORT_A=7301 N2F_RATE_LIMIT_PORT_B=7302 $(BUN) run test:rate-limit-cluster

test-e2e: build ## HTTP workflow, dependency restarts and graceful shutdown
	COMPOSE="$(COMPOSE)" sh scripts/e2e.sh

DURABLE_SUITES = test-postgres test-nats test-recovery test-audit-redelivery test-restart \
	test-rate-limit-cluster test-e2e

test-durable: $(DURABLE_SUITES) ## Every suite that needs infrastructure

ci: check test-memory test-durable ## Everything CI runs after infra-up

fork-check: ## Prove a fork can delete the example modules (runs in a temporary copy)
	sh scripts/prove-fork-removal.sh

mutation: ## Mutation-test the domain layers with Stryker (slow; reports/mutation)
	$(BUN) x stryker run
