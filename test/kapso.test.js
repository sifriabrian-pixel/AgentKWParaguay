const test = require('node:test');
const assert = require('node:assert');
require('./helpers');
const whatsapp = require('../src/whatsapp');
const kapso = require('../src/kapso');

async function conEntorno(vars, fn) {
  const previo = {};
  for (const [k, v] of Object.entries(vars)) {
    previo[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// fetch falso: registra las llamadas y responde según la ruta.
function fakeFetch(responder) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    const { status = 200, json = {} } = responder(call) || {};
    return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

const KAPSO_ENV = {
  WHATSAPP_PROVIDER: 'kapso',
  WHATSAPP_DRY_RUN: undefined,
  KAPSO_API_KEY: 'kapso_test',
  WHATSAPP_PHONE_NUMBER_ID: '111222333',
  KAPSO_WEBHOOK_SECRET: 'k4pso',
  KAPSO_WEBHOOK_URL: undefined,
  RAILWAY_PUBLIC_DOMAIN: 'agente.up.railway.app',
};

test('con Kapso los mensajes salen por la API de Kapso con la API key', async () => {
  const f = fakeFetch(() => ({ json: { messages: [{ id: 'wamid.k1' }] } }));
  try {
    await conEntorno(KAPSO_ENV, async () => {
      const res = await whatsapp.sendMessage('5493415492801', 'hola');
      assert.equal(res.messages[0].id, 'wamid.k1');
    });
    assert.equal(f.calls[0].url, 'https://api.kapso.ai/meta/whatsapp/v24.0/111222333/messages');
    assert.equal(f.calls[0].headers['X-API-Key'], 'kapso_test');
    assert.equal(f.calls[0].headers.Authorization, undefined);
    assert.deepEqual(f.calls[0].body, { messaging_product: 'whatsapp', to: '543415492801', type: 'text', text: { body: 'hola' } });
  } finally { f.restore(); }
});

test('sin proveedor configurado se sigue usando Meta directo', async () => {
  const f = fakeFetch(() => ({ json: { messages: [{ id: 'wamid.m1' }] } }));
  try {
    await conEntorno({ ...KAPSO_ENV, WHATSAPP_PROVIDER: undefined, WHATSAPP_TOKEN: 'meta_token' }, () => whatsapp.sendMessage('595981000001', 'hola'));
    assert.equal(f.calls[0].url, 'https://graph.facebook.com/v21.0/111222333/messages');
    assert.equal(f.calls[0].headers.Authorization, 'Bearer meta_token');
  } finally { f.restore(); }
});

test('ensureWebhook crea el webhook meta con la URL de Railway y el secreto', async () => {
  const f = fakeFetch((c) => (c.method === 'GET' ? { json: { data: [] } } : { json: { data: { id: 'wh1' } } }));
  try {
    const r = await conEntorno(KAPSO_ENV, () => kapso.ensureWebhook());
    assert.equal(r.estado, 'creado');
    assert.equal(f.calls[0].url, 'https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/111222333/webhooks?kind=meta');
    assert.equal(f.calls[1].method, 'POST');
    assert.deepEqual(f.calls[1].body, { whatsapp_webhook: { kind: 'meta', url: 'https://agente.up.railway.app/webhook', secret_key: 'k4pso', active: true } });
  } finally { f.restore(); }
});

test('ensureWebhook actualiza el secreto si el webhook ya apunta acá', async () => {
  const f = fakeFetch((c) => (c.method === 'GET'
    ? { json: { data: [{ id: 'wh1', kind: 'meta', url: 'https://agente.up.railway.app/webhook', active: false }] } }
    : { json: { data: { id: 'wh1' } } }));
  try {
    const r = await conEntorno(KAPSO_ENV, () => kapso.ensureWebhook());
    assert.equal(r.estado, 'actualizado');
    assert.equal(f.calls[1].method, 'PATCH');
    assert.match(f.calls[1].url, /\/webhooks\/wh1$/);
    assert.deepEqual(f.calls[1].body, { whatsapp_webhook: { secret_key: 'k4pso', active: true } });
  } finally { f.restore(); }
});

test('ensureWebhook no pisa un webhook que apunta a otro sistema', async () => {
  const f = fakeFetch(() => ({ json: { data: [{ id: 'wh9', kind: 'meta', url: 'https://otro.sistema/hook' }] } }));
  try {
    const r = await conEntorno(KAPSO_ENV, () => kapso.ensureWebhook());
    assert.equal(r.estado, 'otra_url');
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('ensureWebhook no hace nada si faltan datos, y no lanza si Kapso falla', async () => {
  const f = fakeFetch(() => ({ status: 401, json: { error: 'unauthorized' } }));
  try {
    const sinSecreto = await conEntorno({ ...KAPSO_ENV, KAPSO_WEBHOOK_SECRET: undefined }, () => kapso.ensureWebhook());
    assert.equal(sinSecreto.estado, 'omitido');
    assert.equal(f.calls.length, 0);
    const conError = await conEntorno(KAPSO_ENV, () => kapso.ensureWebhook());
    assert.equal(conError.estado, 'error');
  } finally { f.restore(); }
});
