# Common tasks. `make help` lists them. Requires Bun (https://bun.sh) and uv (https://docs.astral.sh/uv/).

HAYBARN_VERSION ?= 2.0.1rc3
WORKER          := $(CURDIR)/bin/vgi-etf-globalx-worker
TOOLS           := $(CURDIR)/.tools
HAYBARN_UNITTEST := $(TOOLS)/bin/haybarn-unittest
TRANSPORT       ?= stdio
# *_live.test hit Global X and run only with GLOBALX_LIVE=1 (make test-sql-live).
EXPECTED_SKIP_REASONS ?= require-env GLOBALX_LIVE

.DEFAULT_GOAL := help
.PHONY: help build tools typecheck test-unit test-sql test-sql-all test-sql-live test check

help: ## List the targets
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  %-14s %s\n",$$1,$$2}' $(MAKEFILE_LIST)

build: ## Install the worker's dependencies into node_modules
	bun install --frozen-lockfile

tools: ## Install the pinned SQL test runner into .tools
	@test -x $(HAYBARN_UNITTEST) || { uv venv -q $(TOOLS) && uv pip install -q -p $(TOOLS) haybarn-unittest==$(HAYBARN_VERSION); }

typecheck: build ## tsc --noEmit over this repo's own sources
	bun run typecheck

test-unit: build ## Unit tests (bun test)
	bun test

test-sql: build tools ## SQL tests through DuckDB: make test-sql TRANSPORT=stdio|launch|http
	WORKER=$(WORKER) HAYBARN_UNITTEST=$(HAYBARN_UNITTEST) TRANSPORT=$(TRANSPORT) EXPECTED_SKIP_REASONS="$(EXPECTED_SKIP_REASONS)" ci/run-integration.sh

test-sql-all: ## SQL tests over every transport
	$(MAKE) test-sql TRANSPORT=stdio
	$(MAKE) test-sql TRANSPORT=launch
	$(MAKE) test-sql TRANSPORT=http

test-sql-live: ## SQL tests including the live Global X invariants (stdio)
	GLOBALX_LIVE=1 $(MAKE) test-sql TRANSPORT=stdio

test: test-unit test-sql ## Unit + SQL tests

check: typecheck test-unit test-sql-all ## Everything CI runs except vgi-lint
