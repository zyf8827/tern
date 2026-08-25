# Tern

> Distributed Playwright Test Execution Platform

Tern is a lightweight, distributed platform designed for running Playwright end-to-end tests across multiple workers.

## Architecture

- `packages/sdk`: Client SDK and shared types
- `packages/case-bundler`: Case bundler with frontmatter metadata extraction
- `apps/server`: Fastify orchestrator with SQLite and migrations

## Getting Started

```bash
pnpm install
pnpm build
pnpm start:server
```
