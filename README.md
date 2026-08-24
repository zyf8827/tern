# Tern

> Distributed Playwright Test Execution Platform

Tern is a lightweight, distributed platform designed for running Playwright end-to-end tests across multiple workers.

## Monorepo Layout

- `packages/sdk`: Client SDK and shared types
- `packages/`: Additional libraries
- `apps/`: Application services

## Getting Started

```bash
pnpm install
pnpm build
```

## Usage (@tern/sdk)

```typescript
import { TernClientStub } from '@tern/sdk';
const client = new TernClientStub('http://localhost:3000');
```
