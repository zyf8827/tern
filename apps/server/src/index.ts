import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { runMigrations } from './migrations.js';
import { createEventBus } from './events.js';
import { log } from './ansi.js';

const cfg = loadConfig();
const db = openDb(cfg);
runMigrations(db);

const rt = {
  cfg,
  db,
  events: createEventBus(),
};

const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

app.get('/health', async () => ({ status: 'ok', version: cfg.version }));

await app.listen({ port: cfg.port, host: cfg.host });
log.info({ port: cfg.port }, `tern server v${cfg.version} listening`);
