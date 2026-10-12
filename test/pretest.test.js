const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const config = require('../config/kw-py');
const repo = require('../src/repo');
const agent = require('../src/agent');
const webhook = require('../src/webhook');
const whatsapp = require('../src/whatsapp');

const WA = '595983000001';
const ASESORA = { id: 'ana', nombre: 'Ana', whatsapp: '595981000201', activa: true, flujos: ['compra'], zonas: [], proyectos: [] };
const COMPRA = { nombre: 'Luz', tipo: 'casa', zona: 'Luque', presupuesto: 90000, moneda: 'USD', diaContacto: 'martes' };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const textoDe = (call) => call.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content).join('\n');

test('si entra un mensaje mientras Claude responde, se contesta todo junto en una sola respuesta', async () => {
  h.openDb(h.tmpDbPath());
  const sent = h.captureSends();
  const calls = h.fakeClaude(async (params, n) => {
    await dormir(40);
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: `respuesta ${n}` }] };
  });

  webhook.handlePayload(h.waPayload(WA, h.text('para vivir')));
  await dormir(10); // Claude ya está respondiendo el primero
  webhook.handlePayload(h.waPayload(WA, h.text('quiero visitarlo')));
  await agent.idle();

  assert.equal(sent.length, 1, 'una sola respuesta al lead');
  assert.equal(sent[0].text, 'respuesta 2');
  assert.equal(calls.length, 2);
  assert.match(textoDe(calls[1]), /para vivir\nquiero visitarlo/);
  assert.equal(h.db.get().prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'out'").get().n, 1);
  assert.equal(repo.pendingInbound(WA).length, 0);
});

test('antes de responder espera a que el lead deje de escribir', async () => {
  process.env.ESPERA_MENSAJES_MS = '60';
  try {
    h.openDb(h.tmpDbPath());
    const sent = h.captureSends();
    const calls = h.fakeClaude(h.toolThenText(null, 'Perfecto.'));

    webhook.handlePayload(h.waPayload(WA, h.text('2 dormitorios')));
    await dormir(20);
    webhook.handlePayload(h.waPayload(WA, h.text('hasta 170.000 dólares')));
    await agent.idle();

    assert.equal(calls.length, 1, 'una sola llamada a Claude con los dos mensajes');
    assert.match(textoDe(calls[0]), /2 dormitorios\nhasta 170\.000 dólares/);
    assert.equal(sent.length, 1);
  } finally {
    process.env.ESPERA_MENSAJES_MS = '0';
  }
});

test('#reiniciar: el número arranca de cero, sin borrar lo anterior', async () => {
  h.openDb(h.tmpDbPath());
  let sent = h.captureSends();
  h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: { nombre: 'Luz', tipo: 'casa' } }, '¿En qué zona busca?'));
  webhook.handlePayload(h.waPayload(WA, h.text('soy Luz, busco casa'), { name: 'Luz G.' }));
  await agent.idle();
  const anterior = repo.getCurrentLead(WA);

  sent = h.captureSends();
  let calls = h.fakeClaude(h.toolThenText(null, 'no debería llamarse'));
  webhook.handlePayload(h.waPayload(WA, h.text('  #Reiniciar ')));
  await agent.idle();
  await dormir(10);
  assert.equal(calls.length, 0, 'el comando no llega a Claude');
  assert.deepEqual(sent.map((s) => s.text), ['Conversación reiniciada. Puede empezar de nuevo.']);

  const nuevo = repo.getCurrentLead(WA);
  assert.notEqual(nuevo.id, anterior.id);
  assert.equal(nuevo.flujo, null);
  assert.deepEqual(nuevo.datos, {});
  assert.equal(nuevo.nombre_perfil, 'Luz G.');
  assert.equal(repo.getLead(anterior.id).status, 'cerrado');
  assert.deepEqual(repo.getLead(anterior.id).datos, { nombre: 'Luz', tipo: 'casa' });
  assert.equal(h.db.get().prepare('SELECT COUNT(*) n FROM messages').get().n, 2, 'los mensajes anteriores siguen en la base');

  // La conversación siguiente no ve nada de la anterior.
  calls = h.fakeClaude(h.toolThenText(null, '¡Hola! ¿En qué le puedo ayudar?'));
  webhook.handlePayload(h.waPayload(WA, h.text('hola')));
  await agent.idle();
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'hola' }]);
  assert.match(calls[0].system[1].text, /Datos ya capturados \(no los vuelva a preguntar\): \{\}/);
});

test('sin el comando configurado, "#reiniciar" es un mensaje más', async () => {
  const original = config.pruebas;
  config.pruebas = {};
  try {
    h.openDb(h.tmpDbPath());
    h.captureSends();
    const calls = h.fakeClaude(h.toolThenText(null, 'Hola'));
    webhook.handlePayload(h.waPayload(WA, h.text('#reiniciar')));
    await agent.idle();
    assert.equal(calls.length, 1);
  } finally {
    config.pruebas = original;
  }
});

test('un aviso al asesor que no salió se reintenta, y no se manda dos veces', async () => {
  config.asesores = [ASESORA];
  const originalTemplate = whatsapp.sendTemplate;
  try {
    h.openDb(h.tmpDbPath());
    whatsapp.sendTemplate = async () => { throw new Error('plantilla sin aprobar'); };
    let avisos = 0;
    let caido = true;
    whatsapp.sendMessage = async (to) => {
      if (to === ASESORA.whatsapp) {
        if (caido) throw new Error('WhatsApp API 500');
        avisos += 1;
      }
      return { messages: [{ id: `wamid.${Math.random()}` }] };
    };
    h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: COMPRA }, 'Listo. [HANDOFF_COMPRADOR]'));
    webhook.handlePayload(h.waPayload(WA, h.text('hola')));
    await agent.idle();

    const lead = repo.getCurrentLead(WA);
    assert.ok(lead.derived_at);
    assert.equal(repo.events(lead.id).filter((e) => e.type === 'advisor_notify_failed').length, 1);

    // Sigue caído: suma un fallo. Cuando vuelve, el aviso sale una sola vez.
    assert.equal(await agent.retryNotices(), 1);
    assert.equal(repo.events(lead.id).filter((e) => e.type === 'advisor_notify_failed').length, 2);
    caido = false;
    assert.equal(await agent.retryNotices(), 1);
    assert.equal(avisos, 1);
    assert.ok(repo.events(lead.id).some((e) => e.type === 'advisor_notified' && e.payload.via === 'texto'));
    assert.equal(await agent.retryNotices(), 0);
    assert.equal(avisos, 1);
  } finally {
    whatsapp.sendTemplate = originalTemplate;
    config.asesores = [];
  }
});

test('después de 5 intentos fallidos el aviso deja de reintentarse', async () => {
  config.asesores = [ASESORA];
  const originalTemplate = whatsapp.sendTemplate;
  try {
    h.openDb(h.tmpDbPath());
    whatsapp.sendTemplate = async () => { throw new Error('plantilla sin aprobar'); };
    whatsapp.sendMessage = async (to) => {
      if (to === ASESORA.whatsapp) throw new Error('WhatsApp API 500');
      return { messages: [{ id: `wamid.${Math.random()}` }] };
    };
    h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: COMPRA }, 'Listo. [HANDOFF_COMPRADOR]'));
    webhook.handlePayload(h.waPayload(WA, h.text('hola')));
    await agent.idle();
    for (let i = 0; i < 10; i++) await agent.retryNotices();
    const lead = repo.getCurrentLead(WA);
    assert.equal(repo.events(lead.id).filter((e) => e.type === 'advisor_notify_failed').length, 5);
  } finally {
    whatsapp.sendTemplate = originalTemplate;
    config.asesores = [];
  }
});
