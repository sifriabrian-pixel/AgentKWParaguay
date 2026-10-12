const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const h = require('./helpers');

const config = require('../config/kw-py');
const repo = require('../src/repo');
const core = require('../src/core');
const agent = require('../src/agent');
const webhook = require('../src/webhook');
const { calificacion } = require('../src/calificacion');
const { createTestAdapter } = require('../src/test-adapter');

const WA = '595981000101';
const msg = (text, extra = {}) => ({ conversationId: WA, from: WA, text, ...extra });

test('el core y el adapter de test no cargan whatsapp.js', () => {
  const script = "require('./src/core'); require('./src/test-adapter');"
    + "process.exit(Object.keys(require.cache).some((f) => /whatsapp\\.js$/.test(f)) ? 1 : 0)";
  const res = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') });
  assert.equal(res.status, 0, 'src/core.js terminó cargando whatsapp.js');
});

test('handleMessage devuelve mensajes, acciones y estado sin enviar nada', async () => {
  const sent = h.captureSends();
  const adapter = createTestAdapter();
  h.fakeClaude(h.toolThenText(
    { flujo: 'compra', datos: { nombre: 'Ana', tipo: 'departamento', zona: 'Luque', presupuesto: 120000, moneda: 'USD' } },
    'Perfecto, Ana. Le paso con un asesor. [HANDOFF_COMPRADOR]',
  ));

  const out = await adapter.handleMessage(msg('Soy Ana, busco depto en Luque hasta 120.000 USD'));

  assert.deepEqual(out.messages, ['Perfecto, Ana. Le paso con un asesor.']);
  assert.equal(out.state.flujo, 'compra');
  assert.equal(out.state.qualified, true);
  assert.deepEqual(out.state.faltantes, []);
  assert.equal(out.state.derived, false);
  assert.deepEqual(out.state.tags, ['HANDOFF_COMPRADOR']);
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].type, 'handoff');
  assert.equal(out.actions[0].payload.tag, 'HANDOFF_COMPRADOR');
  assert.equal(out.actions[0].payload.qualified, true);
  assert.equal(adapter.actions.length, 1);
  assert.equal(adapter.actions[0].conversationId, WA);

  assert.equal(sent.length, 0, 'el core no envía por WhatsApp');
  // La respuesta queda guardada sin enviar: marcarla es trabajo del adapter de WhatsApp.
  assert.equal(h.db.get().prepare("SELECT status FROM messages WHERE direction = 'out'").get().status, 'enviando');
  // El tag no deriva: el lead sigue activo.
  assert.equal(repo.getCurrentLead(WA).status, 'activo');
});

test('handoff sin los datos requeridos: la acción sale marcada como no calificada', async () => {
  const adapter = createTestAdapter();
  h.fakeClaude(h.toolThenText({ flujo: 'alquiler', datos: { tipo: 'casa' } }, 'Le paso con un asesor. [HANDOFF_ARRENDATARIO]'));
  const out = await adapter.handleMessage(msg('quiero alquilar una casa'));
  assert.equal(out.state.qualified, false);
  assert.deepEqual(out.state.faltantes, ['zona', 'presupuesto']);
  assert.equal(out.actions[0].payload.qualified, false);
});

test('si el lead no da el nombre, queda el del perfil de WhatsApp como respaldo', async () => {
  const adapter = createTestAdapter();
  h.fakeClaude(h.toolThenText(null, '¡Hola! ¿En qué le puedo ayudar?'));
  let out = await adapter.handleMessage(msg('hola', { metadata: { profileName: 'Caro P.' } }));
  assert.equal(out.state.nombre, 'Caro P.');

  h.fakeClaude(h.toolThenText({ datos: { nombre: 'Carolina' } }, 'Gracias, Carolina.'));
  out = await adapter.handleMessage(msg('soy Carolina'));
  assert.equal(out.state.nombre, 'Carolina');
});

test('el anuncio se resuelve con el mapa fijo, sin llamar a Meta', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('el core no debería llamar a la red'); };
  try {
    const adapter = createTestAdapter({ ads: { 'ad-luque': 'KWPY | ALQUILER | Luque | -' } });
    const calls = h.fakeClaude(h.toolThenText(null, 'Veo que busca alquilar en Luque, ¿es así?'));
    const out = await adapter.handleMessage(msg('Hola', { metadata: { source: 'ad', adId: 'ad-luque' } }));

    assert.equal(out.state.flujo, 'alquiler');
    assert.equal(out.state.source, 'ctwa');
    assert.match(calls[0].system[1].text, /La pauta define flujo: alquiler, zona\/proyecto: Luque/);
    assert.equal(repo.getCurrentLead(WA).campaign_status, 'ok');

    // Un anuncio que no está en el mapa: el lead entra igual.
    const otro = await adapter.handleMessage({ conversationId: '595981000102', from: '595981000102', text: 'Hola', metadata: { adId: 'ad-desconocido' } });
    assert.equal(otro.messages.length, 1);
    assert.equal(repo.getCurrentLead('595981000102').campaign_status, 'api_failed');
  } finally {
    global.fetch = realFetch;
  }
});

test('el reloj es inyectable: la hora del turno es la que se le pasa', async () => {
  const adapter = createTestAdapter();
  const calls = h.fakeClaude(h.toolThenText({ aviso_privacidad_enviado: true }, 'Hola'));
  const now = '2027-03-01T15:00:00.000Z';
  await adapter.handleMessage(msg('hola', { now }));

  const lead = repo.getCurrentLead(WA);
  assert.equal(lead.created_at, now);
  assert.equal(lead.last_inbound_at, now);
  assert.equal(lead.consent_at, now);
  assert.match(calls[0].system[1].text, /1 de marzo/);
  const fechas = h.db.get().prepare('SELECT DISTINCT created_at FROM messages').all().map((r) => r.created_at);
  assert.deepEqual(fechas, [now]);

  // Fuera de un turno con hora fijada, el reloj vuelve a ser el real.
  assert.notEqual(require('../src/clock').nowISO(), now);
});

test('tick todavía no genera seguimientos', async () => {
  const adapter = createTestAdapter();
  h.fakeClaude(h.toolThenText({ flujo: 'compra' }, 'Hola'));
  await adapter.handleMessage(msg('quiero comprar', { now: '2027-03-01T15:00:00.000Z' }));
  const out = await adapter.tick(WA, '2027-03-03T15:00:00.000Z');
  assert.deepEqual(out.messages, []);
  assert.deepEqual(out.actions, []);
  assert.equal(out.state.flujo, 'compra');
});

test('un mensaje repetido (mismo messageId) no genera otra respuesta', async () => {
  const adapter = createTestAdapter();
  const calls = h.fakeClaude(h.toolThenText(null, 'Hola'));
  const primero = await adapter.handleMessage(msg('hola', { messageId: 'wamid.X' }));
  const repetido = await adapter.handleMessage(msg('hola', { messageId: 'wamid.X' }));
  assert.equal(primero.messages.length, 1);
  assert.deepEqual(repetido.messages, []);
  assert.equal(calls.length, 1);
});

test('si Claude falla, handleMessage lanza y el mensaje queda pendiente', async () => {
  const adapter = createTestAdapter();
  h.fakeClaude(async () => { throw new Error('529 overloaded'); });
  await assert.rejects(adapter.handleMessage(msg('hola')), /529/);
  assert.equal(repo.pendingInbound(WA).length, 1);
});

test('el CV del postulante sale como acción forward_document y el adapter de WhatsApp la ejecuta', async () => {
  const original = config.reclutamiento.whatsapp;
  config.reclutamiento.whatsapp = '595981999999';
  try {
    // Core: devuelve la acción, no reenvía.
    let sent = h.captureSends();
    const adapter = createTestAdapter();
    h.fakeClaude(h.toolThenText({ flujo: 'reclutamiento', datos: { nombre: 'Luis' } }, 'ok'));
    await adapter.handleMessage(msg('quiero ser agente, soy Luis'));
    h.fakeClaude(h.toolThenText(null, '¡Gracias! Se lo paso al equipo.'));
    const out = await adapter.handleMessage(msg('[Envió un documento: cv.pdf]', { type: 'document', attachments: [{ type: 'document', mediaId: 'media_cv' }] }));
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].type, 'forward_document');
    assert.deepEqual(
      { to: out.actions[0].payload.to, mediaType: out.actions[0].payload.mediaType, mediaId: out.actions[0].payload.mediaId },
      { to: '595981999999', mediaType: 'document', mediaId: 'media_cv' },
    );
    assert.match(out.actions[0].payload.caption, /Luis/);
    assert.equal(sent.length, 0);

    // Adapter de WhatsApp: reenvía el documento y después responde al lead.
    h.openDb(h.tmpDbPath());
    sent = h.captureSends();
    h.fakeClaude(h.toolThenText({ flujo: 'reclutamiento', datos: { nombre: 'Luis' } }, 'ok'));
    webhook.handlePayload(h.waPayload(WA, h.text('quiero ser agente, soy Luis')));
    await agent.idle();
    h.fakeClaude(h.toolThenText(null, '¡Gracias! Se lo paso al equipo.'));
    webhook.handlePayload(h.waPayload(WA, { type: 'document', document: { id: 'media_cv', filename: 'cv.pdf' } }));
    await agent.idle();

    assert.deepEqual(sent.map((s) => s.to), [WA, '595981999999', WA]);
    assert.equal(sent[1].mediaId, 'media_cv');
    const lead = repo.getCurrentLead(WA);
    assert.ok(repo.events(lead.id).some((e) => e.type === 'document_forwarded' && e.payload.media_id === 'media_cv'));
  } finally {
    config.reclutamiento.whatsapp = original;
  }
});

test('el adapter de test se niega a arrancar con credenciales reales en el entorno', () => {
  process.env.WHATSAPP_TOKEN = 'x';
  try {
    assert.throws(() => createTestAdapter(), /credenciales reales/);
  } finally {
    delete process.env.WHATSAPP_TOKEN;
  }
});

test('calificacion compara los datos contra los requeridos de cada flujo', () => {
  assert.deepEqual(calificacion('compra', { tipo: 'casa', zona: 'Luque', presupuesto: 90000 }), { qualified: true, faltantes: [] });
  assert.deepEqual(calificacion('alquiler', { tipo: 'casa', zona: 'Luque' }), { qualified: false, faltantes: ['presupuesto'] });
  assert.deepEqual(calificacion('captacion', { operacion: 'venta', zona: 'Luque', dia: 'martes', franja: 'tarde' }), { qualified: true, faltantes: [] });
  assert.deepEqual(calificacion('captacion', { operacion: 'venta', zona: 'Luque' }), { qualified: false, faltantes: ['dia', 'franja'] });
  const postulante = { ciudad: 'Asunción', disponibilidad: 'parcial', entrevistaConfirmada: true };
  assert.equal(calificacion('reclutamiento', postulante).qualified, true);
  assert.equal(calificacion('reclutamiento', { ...postulante, entrevistaConfirmada: false }).qualified, false);
  assert.equal(calificacion('reclutamiento', { ...postulante, descalificado: true }).qualified, false);
  // El nombre no es requerido en ningún flujo; sin flujo no hay calificación.
  assert.equal(calificacion(null, { tipo: 'casa', zona: 'Luque', presupuesto: 1 }).qualified, false);
  // Los requeridos salen de config: se pueden cambiar sin tocar el código.
  assert.equal(calificacion('captacion', { zona: 'Luque' }, { captacion: { requeridos: ['zona'] } }).qualified, true);
});

test('core.ingest sin texto ni adjunto solo registra el origen del lead', () => {
  h.openDb(h.tmpDbPath());
  const { lead, nuevo } = core.ingest({ conversationId: WA, from: WA, text: null, metadata: { adId: 'ad-9' } });
  assert.equal(nuevo, false);
  assert.equal(lead.source, 'ctwa');
  assert.equal(lead.ad_id, 'ad-9');
  assert.equal(repo.pendingInbound(WA).length, 0);
});
