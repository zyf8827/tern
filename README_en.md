# Tern

> Distributed Playwright Test Execution Platform

Tern is a lightweight, distributed platform designed for running Playwright end-to-end tests across multiple workers.

## Architecture

- `packages/sdk`: Client SDK and shared types
- `packages/case-bundler`: Case bundler with frontmatter metadata extraction
- `packages/exec-kit`: Playwright runner and reporter
- `apps/server`: Fastify orchestrator with SQLite and migrations
- `apps/worker`: Outbound WebSocket agent running test cases
- `apps/web`: React management console

## Getting Started

```bash
pnpm install
pnpm build
pnpm start:server
pnpm start:worker
```
