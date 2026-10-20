import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, explorerUrl } from './config';
import { EscrowStore, HttpError } from './store';
import { openapi, docsHtml } from './openapi';
import {
  createRegistry,
  type Registry,
  HTTP_DURATION_BUCKETS,
  constantTimeEqual,
} from './metrics';

const startedAt = Date.now();

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    next(err);
  }
};

const id = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_id', 'id must be a positive integer');
  return n;
};

export function createApp(store: EscrowStore = new EscrowStore().seed(), opts: { registry?: Registry } = {}) {
  const registry = opts.registry ?? createRegistry();
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  // HTTP RED metrics: request counter and latency histogram.
  // Route uses the Express route pattern (bounded cardinality), never raw path ids.
  const httpRequestsTotal = registry.counter(
    'http_requests_total',
    'Total number of HTTP requests',
    ['method', 'route', 'status'],
  );
  const httpRequestDuration = registry.histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds',
    ['method', 'route'],
    HTTP_DURATION_BUCKETS,
  );

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationSeconds = (Date.now() - start) / 1000;
      const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
      httpRequestsTotal.inc({ method: req.method, route, status: String(res.statusCode) });
      httpRequestDuration.observe({ method: req.method, route }, durationSeconds);
    });
    next();
  });

  // Domain mutation counter: incremented in the store layer.
  const escrowMutationsTotal = registry.counter(
    'escrow_mutations_total',
    'Total number of escrow mutations',
    ['action', 'result'],
  );
  store.setMutationRecorder((action, result) => escrowMutationsTotal.inc({ action, result }));

  app.get(
    '/',
    wrap(() => ({
      name: 'TalentTrust API',
      version: config.version,
      description: 'Milestone-based freelancer escrow API backed by a Soroban contract on Stellar.',
      docs: '/docs',
      openapi: '/openapi.json',
      website: config.frontendUrl,
      chain: { network: config.network, contractId: config.contractId, explorer: explorerUrl() },
      endpoints: [
        'GET  /health',
        'GET  /docs',
        'GET  /openapi.json',
        'GET  /api/v1/chain',
        'GET  /api/v1/stats',
        'GET  /api/v1/contracts',
        'POST /api/v1/contracts',
        'GET  /api/v1/contracts/:id',
        'POST /api/v1/contracts/:id/deposit',
        'POST /api/v1/contracts/:id/milestones/:index/release',
        'POST /api/v1/contracts/:id/dispute',
        'POST /api/v1/contracts/:id/resolve',
        'POST /api/v1/contracts/:id/cancel',
        'POST /api/v1/contracts/:id/reputation',
        'GET  /api/v1/reputation/:address',
      ],
    })),
  );

  app.get(
    '/health',
    wrap(() => ({
      status: 'ok',
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      storage: 'in-memory',
      timestamp: new Date().toISOString(),
    })),
  );

  app.get('/openapi.json', wrap(() => openapi));
  app.get(['/docs', '/docs/'], (_req, res) => {
    res.type('html').send(docsHtml);
  });

  const v1 = express.Router();
  v1.get(
    '/chain',
    wrap(() => ({
      network: config.network,
      rpcUrl: config.rpcUrl,
      contractId: config.contractId,
      explorer: explorerUrl(),
    })),
  );
  v1.get('/stats', wrap(() => store.stats()));
  v1.get(
    '/contracts',
    wrap((req) => ({
      data: store.list({
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        party: typeof req.query.party === 'string' ? req.query.party : undefined,
      }),
    })),
  );
  v1.post(
    '/contracts',
    wrap((req, res) => {
      res.status(201).json(store.create(req.body ?? {}));
    }),
  );
  v1.get('/contracts/:id', wrap((req) => store.get(id(req))));
  v1.post('/contracts/:id/deposit', wrap((req) => store.deposit(id(req), req.body?.amount)));
  v1.post(
    '/contracts/:id/milestones/:index/release',
    wrap((req) => store.release(id(req), Number(req.params.index))),
  );
  v1.post(
    '/contracts/:id/dispute',
    wrap((req) => store.openDispute(id(req), req.body?.raisedBy, req.body?.reason)),
  );
  v1.post('/contracts/:id/resolve', wrap((req) => store.resolveDispute(id(req), req.body?.freelancerBps)));
  v1.post('/contracts/:id/cancel', wrap((req) => store.cancel(id(req))));
  v1.post('/contracts/:id/reputation', wrap((req) => store.rate(id(req), req.body?.rating)));
  v1.get('/reputation/:address', wrap((req) => store.getReputation(req.params.address)));
  app.use('/api/v1', v1);

  // /metrics is disabled (404) when METRICS_TOKEN is unset; checked at request time.
  const escrowContracts = registry.gauge('escrow_contracts', 'Escrow contracts by status', ['status']);
  const escrowValueEscrowed = registry.gauge('escrow_value_escrowed', 'Value currently escrowed', []);
  const escrowValueReleased = registry.gauge('escrow_value_released', 'Value released', []);
  const processUptime = registry.gauge('process_uptime_seconds', 'Process uptime in seconds', []);
  const nodejsHeapUsed = registry.gauge('nodejs_heap_used_bytes', 'Node.js heap used in bytes', []);

  app.get('/metrics', (req, res) => {
    if (!process.env.METRICS_TOKEN) {
      res.status(404).json({ error: 'not_found', message: 'Metrics endpoint disabled' });
      return;
    }
    const auth = req.headers['authorization'];
    const provided = Array.isArray(auth) ? auth[0] : auth;
    const expected = 'Bearer ' + process.env.METRICS_TOKEN!;
    if (!provided || !constantTimeEqual(provided, expected)) {
      res.status(401).json({ error: 'unauthorized', message: 'Invalid metrics token' });
      return;
    }
    const stats = store.stats();
    for (const [status, count] of Object.entries(stats.byStatus)) {
      escrowContracts.set({ status }, count);
    }
    escrowValueEscrowed.set({}, stats.totalEscrowed);
    escrowValueReleased.set({}, stats.totalReleased);
    processUptime.set({}, process.uptime());
    nodejsHeapUsed.set({}, process.memoryUsage().heapUsed);
    res.type('text/plain; version=0.0.4').send(registry.exposition());
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}`, docs: '/docs' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Malformed JSON body' });
      return;
    }
    res.status(500).json({ error: 'internal_error', message: 'Unexpected error' });
  });

  return app;
}

export default createApp;
