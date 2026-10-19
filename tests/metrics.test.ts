import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { constantTimeEqual } from '../src/metrics';

function metricSample(body: string, name: string, labels: Record<string, string>): number | undefined {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}\\s+(.+)$`);
  for (const line of body.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const labelMap: Record<string, string> = {};
    for (const pair of m[1].split(',')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      labelMap[pair.slice(0, eq).trim()] = pair.slice(eq + 1).replace(/^"|"$/g, '');
    }
    let match = true;
    for (const [k, v] of Object.entries(labels)) {
      if (labelMap[k] !== v) { match = false; break; }
    }
    if (match) return parseFloat(m[2].trim());
  }
  return undefined;
}

function appWithToken(token = 'test-token') {
  process.env.METRICS_TOKEN = token;
  const app = createApp(new EscrowStore());
  return { app };
}

describe('Prometheus metrics', () => {
  afterEach(() => {
    delete process.env.METRICS_TOKEN;
  });

  it('constant-time token comparison', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('Bearer x', 'Bearer y')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('returns 404 when METRICS_TOKEN is unset', async () => {
    delete process.env.METRICS_TOKEN;
    const app = createApp(new EscrowStore());
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(404);
  });

  it('returns 401 without a token', async () => {
    const { app } = appWithToken();
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong token', async () => {
    const { app } = appWithToken();
    const res = await request(app).get('/metrics').set('authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid exposition format', async () => {
    const { app } = appWithToken();
    const res = await request(app).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] || '').toContain('text/plain');
    expect(res.text).toContain('# TYPE http_requests_total counter');
    expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(res.text).toContain('# TYPE escrow_mutations_total counter');
    expect(res.text).toContain('# TYPE escrow_contracts gauge');
    expect(res.text).toContain('# TYPE process_uptime_seconds gauge');
    expect(res.text).toContain('# TYPE nodejs_heap_used_bytes gauge');
  });

  it('counts requests by route pattern, not raw path', async () => {
    const { app } = appWithToken();
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/v1/contracts/999').expect(404);
    }
    const res = await request(app).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    const value = metricSample(res.text, 'http_requests_total', {
      method: 'GET',
      route: '/api/v1/contracts/:id',
      status: '404',
    });
    expect(value).toBe(3);
  });

  it('increments escrow_mutations_total for over_funded deposit', async () => {
    const { app } = appWithToken();
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] })
      .expect(201);
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 1 }).expect(409);

    const res = await request(app).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    const value = metricSample(res.text, 'escrow_mutations_total', { action: 'deposit', result: 'over_funded' });
    expect(value).toBe(1);
  });

  it('does not share counters between two createApp() instances', async () => {
    process.env.METRICS_TOKEN = 'test-token';
    const app1 = createApp(new EscrowStore().seed());
    await request(app1).get('/api/v1/contracts/1').expect(200);

    const app2 = createApp(new EscrowStore());
    const res2 = await request(app2).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res2.status).toBe(200);
    const value = metricSample(res2.text, 'http_requests_total', {
      method: 'GET',
      route: '/api/v1/contracts/:id',
      status: '200',
    });
    expect(value).toBeUndefined();

    const res1 = await request(app1).get('/metrics').set('authorization', 'Bearer test-token');
    expect(res1.status).toBe(200);
    const value1 = metricSample(res1.text, 'http_requests_total', {
      method: 'GET',
      route: '/api/v1/contracts/:id',
      status: '200',
    });
    expect(value1).toBeGreaterThanOrEqual(1);
    delete process.env.METRICS_TOKEN;
  });
});
