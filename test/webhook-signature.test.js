const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
require('./helpers');
const { verifySignature } = require('../src/whatsapp');

const body = Buffer.from('{"entry":[]}');
const firmar = (secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

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

test('sin App Secret el webhook rechaza todo, salvo en modo prueba', () => {
  conEntorno({ WHATSAPP_APP_SECRET: undefined, WHATSAPP_DRY_RUN: undefined }, () => {
    assert.equal(verifySignature(body, undefined), false);
    assert.equal(verifySignature(body, firmar('cualquiera')), false);
  });
  conEntorno({ WHATSAPP_APP_SECRET: '', WHATSAPP_DRY_RUN: '1' }, () => {
    assert.equal(verifySignature(body, undefined), true);
  });
});

test('con App Secret solo pasa la firma correcta, también en modo prueba', () => {
  for (const dry of [undefined, '1']) {
    conEntorno({ WHATSAPP_APP_SECRET: 's3cret', WHATSAPP_DRY_RUN: dry }, () => {
      assert.equal(verifySignature(body, firmar('s3cret')), true);
      assert.equal(verifySignature(body, firmar('otro')), false);
      assert.equal(verifySignature(body, undefined), false);
    });
  }
});
