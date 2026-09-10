# Tern

> Distributed Playwright Test Execution Platform for Coding Agents

Tern is a lightweight, distributed platform designed for running Playwright end-to-end tests across multiple workers.

## Features

- **Distributed test execution**: WebSocket workers with concurrency management
- **Dynamic case bundling**: Fast frontmatter parser and esbuild bundler
- **MCP Server**: Model Context Protocol tools for AI coding agents
- **Agent Skill Template**: `skills/tern-project` for autonomous E2E workflows
- **CLI & Web UI**: Full visibility into test runs and artifacts

## Quickstart

```bash
pnpm install
pnpm build
pnpm start:server
```
