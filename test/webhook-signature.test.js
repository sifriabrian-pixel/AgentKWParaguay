const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
require('./helpers');
const { verifySignature } = require('../src/whatsapp');

const body = Buffer.from('{"entry":[]}');
const firmarMeta = (secret) => ({ 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex') });
const firmarKapso = (secret) => ({ 'x-webhook-signature': crypto.createHmac('sha256', secret).update(body).digest('hex') });

function conEntorno(vars, fn) {
  const previo = {};
  for (const [k, v] of Object.entries(vars)) {
    previo[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('Meta: sin App Secret el webhook rechaza todo, salvo en modo prueba', () => {
  conEntorno({ WHATSAPP_PROVIDER: undefined, WHATSAPP_APP_SECRET: undefined, WHATSAPP_DRY_RUN: undefined }, () => {
    assert.equal(verifySignature(body, {}), false);
    assert.equal(verifySignature(body, firmarMeta('cualquiera')), false);
  });
  conEntorno({ WHATSAPP_PROVIDER: undefined, WHATSAPP_APP_SECRET: '', WHATSAPP_DRY_RUN: '1' }, () => {
    assert.equal(verifySignature(body, {}), true);
  });
});

test('Meta: con App Secret solo pasa la firma correcta, también en modo prueba', () => {
  for (const dry of [undefined, '1']) {
    conEntorno({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_APP_SECRET: 's3cret', WHATSAPP_DRY_RUN: dry }, () => {
      assert.equal(verifySignature(body, firmarMeta('s3cret')), true);
      assert.equal(verifySignature(body, firmarMeta('otro')), false);
      assert.equal(verifySignature(body, {}), false);
      // La firma de Kapso no sirve con el proveedor Meta.
      assert.equal(verifySignature(body, firmarKapso('s3cret')), false);
    });
  }
});

test('Kapso: solo pasa la firma X-Webhook-Signature con el secreto del webhook', () => {
  for (const dry of [undefined, '1']) {
    conEntorno({ WHATSAPP_PROVIDER: 'kapso', KAPSO_WEBHOOK_SECRET: 'k4pso', WHATSAPP_DRY_RUN: dry }, () => {
      assert.equal(verifySignature(body, firmarKapso('k4pso')), true);
      assert.equal(verifySignature(body, { 'x-webhook-signature': firmarKapso('k4pso')['x-webhook-signature'].toUpperCase() }), true);
      assert.equal(verifySignature(body, firmarKapso('otro')), false);
      assert.equal(verifySignature(body, {}), false);
      // La firma de Meta no sirve con el proveedor Kapso.
      assert.equal(verifySignature(body, firmarMeta('k4pso')), false);
    });
  }
});

test('Kapso: sin secreto rechaza todo, salvo en modo prueba', () => {
  conEntorno({ WHATSAPP_PROVIDER: 'kapso', KAPSO_WEBHOOK_SECRET: undefined, WHATSAPP_DRY_RUN: undefined }, () => {
    assert.equal(verifySignature(body, firmarKapso('x')), false);
  });
  conEntorno({ WHATSAPP_PROVIDER: 'kapso', KAPSO_WEBHOOK_SECRET: undefined, WHATSAPP_DRY_RUN: '1' }, () => {
    assert.equal(verifySignature(body, {}), true);
  });
});
