const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const repo = require('../src/repo');
const agent = require('../src/agent');
const webhook = require('../src/webhook');
const campanas = require('../src/campanas');

const REFERRAL = {
  source_url: 'https://fb.me/abc',
  source_id: '120210000000001',
  source_type: 'ad',
  headline: 'Departamentos en Luque',
  body: 'Escribinos',
  ctwa_clid: 'ARxx_clid',
};

const WA = '595981000001';

test('el referral se guarda aunque el primer mensaje sea un audio', async () => {
  h.openDb(h.tmpDbPath());
  h.fakeClaude(h.toolThenText(null, '¡Hola! ¿Me lo podría escribir?'));
  const sent = h.captureSends();

  webhook.handlePayload(h.waPayload(WA, { type: 'audio', audio: { id: 'media1' } }, { referral: REFERRAL }));
  await agent.idle();

  const lead = repo.getCurrentLead(WA);
  assert.equal(lead.source, 'ctwa');
  assert.equal(lead.ad_id, REFERRAL.source_id);
  assert.equal(lead.ctwa_clid, REFERRAL.ctwa_clid);
  assert.deepEqual(lead.referral, REFERRAL);
  assert.equal(sent.length, 1);
  // Sin token de Meta: el lead entra igual y queda registrado el fallo.
  assert.ok(repo.events(lead.id).some((e) => e.type === 'campaign_parse_failed' && e.payload.motivo === 'sin_token'));
});

test('sin referral el lead es orgánico', async () => {
  h.openDb(h.tmpDbPath());
  h.fakeClaude(h.toolThenText(null, 'Hola'));
  h.captureSends();
  webhook.handlePayload(h.waPayload(WA, h.text('hola')));
  await agent.idle();
  const lead = repo.getCurrentLead(WA);
  assert.equal(lead.source, 'organico');
  assert.equal(lead.ad_id, null);
});

test('un mensaje reenviado por Meta (mismo wa_message_id) se procesa una sola vez', async () => {
  h.openDb(h.tmpDbPath());
  const calls = h.fakeClaude(h.toolThenText(null, 'Hola'));
  const sent = h.captureSends();
  const payload = h.waPayload(WA, h.text('hola', { id: 'wamid.DUP' }));

  webhook.handlePayload(payload);
  webhook.handlePayload(payload);
  await agent.idle();
  webhook.handlePayload(payload);
  await agent.idle();

  assert.equal(calls.length, 1);
  assert.equal(sent.length, 1);
  const n = h.db.get().prepare("SELECT COUNT(*) n FROM messages WHERE direction = 'in'").get().n;
  assert.equal(n, 1);
});

test('guardar_datos escribe en leads.datos y los tags no derivan', async () => {
  h.openDb(h.tmpDbPath());
  h.fakeClaude(h.toolThenText(
    { flujo: 'compra', datos: { nombre: 'Ana', tipo: 'departamento', zona: 'Luque', presupuesto: '120.000', moneda: 'USD', inventado: 'x' }, aviso_privacidad_enviado: true },
    'Perfecto, Ana. Le paso con un asesor. [HANDOFF_COMPRADOR]',
  ));
  const sent = h.captureSends();

  webhook.handlePayload(h.waPayload(WA, h.text('Soy Ana, busco depto en Luque hasta 120.000 USD')));
  await agent.idle();

  const lead = repo.getCurrentLead(WA);
  assert.equal(lead.flujo, 'compra');
  assert.equal(lead.lead_type, 'commercial');
  assert.deepEqual(lead.datos, { nombre: 'Ana', tipo: 'departamento', zona: 'Luque', presupuesto: 120000, moneda: 'USD' });
  assert.ok(lead.consent_at);
  assert.equal(lead.derived_at, null);
  assert.equal(lead.status, 'activo');
  assert.equal(sent[0].text, 'Perfecto, Ana. Le paso con un asesor.');
  assert.ok(repo.events(lead.id).some((e) => e.type === 'llm_tag' && e.payload.tag === 'HANDOFF_COMPRADOR'));
});

test('sobrevive a un reinicio con la conversación a mitad de flujo', async () => {
  const dbPath = h.tmpDbPath();
  h.openDb(dbPath);
  h.fakeClaude(h.toolThenText({ flujo: 'alquiler', datos: { nombre: 'Luis', zona: 'Asunción' } }, '¿Qué tipo de propiedad busca?'));
  const sent = h.captureSends();
  webhook.handlePayload(h.waPayload(WA, h.text('Soy Luis, quiero alquilar en Asunción')));
  await agent.idle();

  // "Redeploy": se cierra la base y se vuelve a abrir el mismo archivo.
  h.openDb(dbPath);
  await agent.recover();
  const calls = h.fakeClaude(h.toolThenText({ datos: { tipo: 'departamento' } }, '¿Cuál es su presupuesto mensual?'));
  webhook.handlePayload(h.waPayload(WA, h.text('Un departamento')));
  await agent.idle();

  const lead = repo.getCurrentLead(WA);
  assert.equal(lead.flujo, 'alquiler');
  assert.deepEqual(lead.datos, { nombre: 'Luis', zona: 'Asunción', tipo: 'departamento' });
  assert.equal(h.db.get().prepare('SELECT COUNT(*) n FROM leads').get().n, 1);

  // Claude recibe el historial completo y los datos ya capturados.
  const primera = calls[0];
  assert.deepEqual(primera.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(primera.messages[1].content, '¿Qué tipo de propiedad busca?');
  assert.match(primera.system[1].text, /"nombre":"Luis"/);
  assert.equal(sent.length, 2);
});

test('mensajes que quedaron pendientes por un corte se responden al reiniciar, una sola vez', async () => {
  const dbPath = h.tmpDbPath();
  h.openDb(dbPath);
  // Simula un corte: el mensaje se guardó pero el proceso murió antes de responder.
  const lead = repo.captureInbound(WA, 'X', REFERRAL);
  repo.insertInbound({ waId: WA, leadId: lead.id, waMessageId: 'wamid.CORTE', type: 'text', body: 'hola?' });

  h.openDb(dbPath);
  const calls = h.fakeClaude(h.toolThenText(null, '¡Hola! ¿En qué le ayudo?'));
  const sent = h.captureSends();
  await agent.recover();
  await agent.recover();

  assert.equal(calls.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(repo.pendingInbound(WA).length, 0);
});

test('una respuesta que quedó "enviando" en el corte no se reenvía', async () => {
  const dbPath = h.tmpDbPath();
  h.openDb(dbPath);
  const lead = repo.captureInbound(WA, 'X', null);
  repo.insertOutbound({ waId: WA, leadId: lead.id, body: 'respuesta a medio enviar' });

  h.openDb(dbPath);
  const sent = h.captureSends();
  await agent.recover();
  assert.equal(sent.length, 0);
  const st = h.db.get().prepare("SELECT status FROM messages WHERE direction = 'out'").get().status;
  assert.equal(st, 'desconocido');
});

test('dos mensajes seguidos del mismo número no se procesan en paralelo', async () => {
  h.openDb(h.tmpDbPath());
  let activos = 0;
  let maxActivos = 0;
  h.fakeClaude(async () => {
    activos += 1;
    maxActivos = Math.max(maxActivos, activos);
    await new Promise((r) => setTimeout(r, 30));
    activos -= 1;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  });
  h.captureSends();

  webhook.handlePayload(h.waPayload(WA, h.text('hola')));
  webhook.handlePayload(h.waPayload(WA, h.text('quiero comprar')));
  webhook.handlePayload(h.waPayload(WA, h.text('en Luque')));
  await agent.idle();

  assert.equal(maxActivos, 1);
  assert.equal(repo.pendingInbound(WA).length, 0);
});

test('números distintos sí se procesan en paralelo', async () => {
  h.openDb(h.tmpDbPath());
  let activos = 0;
  let maxActivos = 0;
  h.fakeClaude(async () => {
    activos += 1;
    maxActivos = Math.max(maxActivos, activos);
    await new Promise((r) => setTimeout(r, 30));
    activos -= 1;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  });
  h.captureSends();
  webhook.handlePayload(h.waPayload('595981000010', h.text('hola')));
  webhook.handlePayload(h.waPayload('595981000011', h.text('hola')));
  await agent.idle();
  assert.equal(maxActivos, 2);
});

test('si Claude falla se reintenta y al tercer error se manda una disculpa', async () => {
  h.openDb(h.tmpDbPath());
  const calls = h.fakeClaude(async () => { throw new Error('529 overloaded'); });
  const sent = h.captureSends();
  webhook.handlePayload(h.waPayload(WA, h.text('hola')));
  for (let i = 0; i < 20 && sent.length === 0; i++) {
    await agent.idle();
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(calls.length, 3);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /inconveniente técnico/);
  assert.equal(repo.pendingInbound(WA).length, 0);
});

test('abrir_flujo_adicional crea un segundo registro con el mismo wa_id', async () => {
  h.openDb(h.tmpDbPath());
  h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: { nombre: 'Ana' } }, 'ok'));
  h.captureSends();
  webhook.handlePayload(h.waPayload(WA, h.text('quiero comprar')));
  await agent.idle();
  const primero = repo.getCurrentLead(WA);

  h.fakeClaude(h.toolThenText({ abrir_flujo_adicional: 'captacion', datos: { operacion: 'venta' } }, 'Perfecto, veamos su casa.'));
  webhook.handlePayload(h.waPayload(WA, h.text('también quiero vender mi casa')));
  await agent.idle();

  const segundo = repo.getCurrentLead(WA);
  assert.notEqual(segundo.id, primero.id);
  assert.equal(segundo.flujo, 'captacion');
  assert.deepEqual(segundo.datos, { nombre: 'Ana', operacion: 'venta' });
  assert.equal(repo.getLead(primero.id).flujo, 'compra');
  assert.ok(repo.events(segundo.id).some((e) => e.type === 'flow_opened'));
});

test('el CV del postulante sin número de reclutamiento queda registrado, no se pierde', async () => {
  h.openDb(h.tmpDbPath());
  h.fakeClaude(h.toolThenText({ flujo: 'reclutamiento' }, 'ok'));
  h.captureSends();
  webhook.handlePayload(h.waPayload(WA, h.text('quiero ser agente')));
  await agent.idle();
  h.fakeClaude(h.toolThenText(null, '¡Gracias! Se lo paso al equipo.'));
  webhook.handlePayload(h.waPayload(WA, { type: 'document', document: { id: 'media_cv', filename: 'cv.pdf' } }));
  await agent.idle();
  const lead = repo.getCurrentLead(WA);
  assert.ok(repo.events(lead.id).some((e) => e.type === 'document_not_forwarded' && e.payload.media_id === 'media_cv'));
});

test('parseCampaignName respeta la convención KWPY | FLUJO | ZONA | ASESOR', () => {
  assert.deepEqual(campanas.parseCampaignName('KWPY | COMPRA | Luque | -'), { flujo: 'compra', zona: 'Luque', asesor: null });
  assert.deepEqual(campanas.parseCampaignName('kwpy|captacion|Villa Morra|Juan Pérez'), { flujo: 'captacion', zona: 'Villa Morra', asesor: 'Juan Pérez' });
  assert.deepEqual(campanas.parseCampaignName('KWPY | RECLUTAMIENTO | Asunción'), { flujo: 'reclutamiento', zona: 'Asunción', asesor: null });
  assert.equal(campanas.parseCampaignName('Campaña Luque Octubre'), null);
  assert.equal(campanas.parseCampaignName('KWPY | VENTA | Luque'), null);
  assert.equal(campanas.parseCampaignName(null), null);
});

test('la campaña se resuelve una vez por anuncio y define el flujo', async () => {
  h.openDb(h.tmpDbPath());
  process.env.META_SYSTEM_TOKEN = 'test';
  const realFetch = global.fetch;
  let metaCalls = 0;
  global.fetch = async (url) => {
    metaCalls += 1;
    assert.match(String(url), /120210000000001/);
    return { ok: true, json: async () => ({ name: 'Ad 1', adset: { name: 'Set 1' }, campaign: { id: 'c1', name: 'KWPY | ALQUILER | Luque | -' } }) };
  };
  try {
    const calls = h.fakeClaude(h.toolThenText(null, 'Veo que busca alquilar en Luque, ¿es así?'));
    h.captureSends();
    webhook.handlePayload(h.waPayload('595981000020', h.text('Hola'), { referral: REFERRAL }));
    webhook.handlePayload(h.waPayload('595981000021', h.text('Info'), { referral: REFERRAL }));
    await agent.idle();

    const lead = repo.getCurrentLead('595981000020');
    assert.equal(lead.campaign_status, 'ok');
    assert.equal(lead.campaign_name, 'KWPY | ALQUILER | Luque | -');
    assert.equal(lead.flujo, 'alquiler');
    assert.equal(lead.campaign_zona, 'Luque');
    assert.equal(repo.getCurrentLead('595981000021').flujo, 'alquiler');
    assert.ok(metaCalls <= 2); // en paralelo puede consultar 2 veces; después usa la cache
    assert.match(calls[0].system[1].text, /La pauta define flujo: alquiler, zona\/proyecto: Luque/);

    metaCalls = 0;
    webhook.handlePayload(h.waPayload('595981000022', h.text('Hola'), { referral: REFERRAL }));
    await agent.idle();
    assert.equal(metaCalls, 0);
    assert.equal(repo.getCurrentLead('595981000022').campaign_status, 'ok');
  } finally {
    global.fetch = realFetch;
    delete process.env.META_SYSTEM_TOKEN;
  }
});

test('si la campaña no respeta la convención, el lead entra igual con campaign_parse_failed', async () => {
  h.openDb(h.tmpDbPath());
  process.env.META_SYSTEM_TOKEN = 'test';
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ name: 'Ad', campaign: { id: 'c9', name: 'Promo octubre' } }) });
  try {
    h.fakeClaude(h.toolThenText(null, 'Hola, ¿en qué le ayudo?'));
    const sent = h.captureSends();
    webhook.handlePayload(h.waPayload(WA, h.text('Hola'), { referral: REFERRAL }));
    await agent.idle();
    const lead = repo.getCurrentLead(WA);
    assert.equal(lead.campaign_status, 'parse_failed');
    assert.equal(lead.campaign_name, 'Promo octubre');
    assert.equal(lead.flujo, null);
    assert.equal(sent.length, 1);
    assert.ok(repo.events(lead.id).some((e) => e.type === 'campaign_parse_failed' && e.payload.motivo === 'convencion'));
  } finally {
    global.fetch = realFetch;
    delete process.env.META_SYSTEM_TOKEN;
  }
});

test('los estados de entrega no retroceden', async () => {
  h.openDb(h.tmpDbPath());
  h.fakeClaude(h.toolThenText(null, 'Hola'));
  h.captureSends();
  webhook.handlePayload(h.waPayload(WA, h.text('hola')));
  await agent.idle();
  const out = h.db.get().prepare("SELECT wa_message_id FROM messages WHERE direction = 'out'").get();
  const st = (status) => ({ entry: [{ changes: [{ value: { statuses: [{ id: out.wa_message_id, status }] } }] }] });
  webhook.handlePayload(st('read'));
  webhook.handlePayload(st('delivered'));
  const fila = h.db.get().prepare("SELECT status FROM messages WHERE direction = 'out'").get();
  assert.equal(fila.status, 'leido');
});
