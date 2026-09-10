# Tern

> Distributed Playwright Test Execution Platform for Coding Agents

Tern is a lightweight, distributed platform designed for running Playwright end-to-end tests across multiple workers.

## Quickstart with Docker Compose

```bash
bash scripts/init-compose.sh
docker compose up -d
```

## Architecture

- `packages/sdk`: Client SDK and shared types
- `packages/case-bundler`: Case bundler with frontmatter metadata extraction
- `packages/exec-kit`: Playwright runner and reporter
- `packages/cli`: Tern CLI for sync, run, and status
- `apps/server`: Fastify orchestrator with SQLite and migrations
- `apps/worker`: Outbound WebSocket agent running test cases
- `apps/web`: React management console
