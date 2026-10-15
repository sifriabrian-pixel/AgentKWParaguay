const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const config = require('../config/kw-py');
const repo = require('../src/repo');
const agent = require('../src/agent');
const webhook = require('../src/webhook');
const whatsapp = require('../src/whatsapp');
const { createTestAdapter } = require('../src/test-adapter');

const ANA = { id: 'ana', nombre: 'Ana', whatsapp: '595981000201', activa: true, flujos: ['compra', 'alquiler'], zonas: [], proyectos: [] };
const BETO = { id: 'beto', nombre: 'Beto', whatsapp: '595981000202', activa: true, flujos: ['compra'], zonas: [], proyectos: [] };
const INACTIVA = { id: 'ines', nombre: 'Inés', whatsapp: '595981000203', activa: false, flujos: ['compra'], zonas: [], proyectos: [] };
const OFICINA = { nombre: 'Oficina', whatsapp: '595981000300' };
const RECLUTAMIENTO = { nombre: 'Rocío', whatsapp: '595981000400' };

function equipo({ asesores = [ANA, BETO, INACTIVA], oficina = OFICINA, reclutamiento = RECLUTAMIENTO } = {}) {
  config.asesores = asesores;
  config.oficina = oficina;
  config.reclutamiento = reclutamiento;
}

const COMPRA = { nombre: 'Luz', tipo: 'casa', zona: 'Luque', presupuesto: 90000, moneda: 'USD' };
let n = 0;
const lead = () => `59598200${String(n += 1).padStart(4, '0')}`;
const msg = (wa, text) => ({ conversationId: wa, from: wa, text });
const avisos = (out) => out.actions.filter((a) => a.type === 'notify_advisor');

test('lead calificado que cierra el flujo: se deriva al asesor del flujo con sus datos', async () => {
  equipo();
  const adapter = createTestAdapter();
  h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: COMPRA }, 'Le paso su consulta a un asesor. [HANDOFF_COMPRADOR]'));
  const wa = lead();
  const out = await adapter.handleMessage(msg(wa, 'busco casa en Luque'));

  assert.equal(avisos(out).length, 1);
  const p = avisos(out)[0].payload;
  assert.equal(p.to, ANA.whatsapp);
  assert.equal(p.regla, 'flujo');
  assert.equal(p.template, 'nuevo_lead_asesor');
  assert.deepEqual(p.params, {
    motivo: 'Lead calificado',
    nombre: 'Luz',
    telefono: `+${wa}`,
    flujo: 'Compra',
    datos: 'casa, Luque, hasta USD 90.000',
    resumen: '-',
  });
  assert.match(p.texto, /Nombre: Luz/);
  assert.equal(out.state.derived, true);
  const guardado = repo.getCurrentLead(wa);
  assert.equal(guardado.status, 'derivado');
  assert.equal(guardado.asesor_id, 'ana');
  assert.ok(guardado.derived_at);
});

test('los leads de un flujo se reparten por turnos entre los asesores activos', async () => {
  equipo();
  const adapter = createTestAdapter();
  const destinos = [];
  for (let i = 0; i < 4; i++) {
    h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: COMPRA }, 'Listo. [HANDOFF_COMPRADOR]'));
    destinos.push(avisos(await adapter.handleMessage(msg(lead(), 'hola')))[0].payload.to);
  }
  assert.deepEqual(destinos, [ANA.whatsapp, BETO.whatsapp, ANA.whatsapp, BETO.whatsapp]);

  // Alquiler tiene su propio turno y solo lo atiende Ana.
  h.fakeClaude(h.toolThenText({ flujo: 'alquiler', datos: COMPRA }, 'Listo. [HANDOFF_ARRENDATARIO]'));
  assert.equal(avisos(await adapter.handleMessage(msg(lead(), 'hola')))[0].payload.to, ANA.whatsapp);
});

test('se deriva una sola vez aunque el LLM repita el tag', async () => {
  equipo();
  const adapter = createTestAdapter();
  const wa = lead();
  h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: COMPRA }, 'Listo. [HANDOFF_COMPRADOR]'));
  assert.equal(avisos(await adapter.handleMessage(msg(wa, 'hola'))).length, 1);
  const calls = h.fakeClaude(h.toolThenText({ datos: { pide_humano: true } }, 'Ya le avisé al asesor. [HANDOFF_COMPRADOR]'));
  const otra = await adapter.handleMessage(msg(wa, '¿y el asesor?'));
  assert.equal(avisos(otra).length, 0);
  assert.match(calls[0].system[1].text, /YA fue derivado/);
  assert.equal(adapter.actions.filter((a) => a.type === 'notify_advisor').length, 1);
});

test('tag de cierre sin los datos requeridos: no deriva; al completarlos sí, sin esperar otro tag', async () => {
  equipo();
  const adapter = createTestAdapter();
  const wa = lead();
  h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: { tipo: 'casa', zona: 'Luque' } }, 'Le paso con un asesor. [HANDOFF_COMPRADOR]'));
  const primero = await adapter.handleMessage(msg(wa, 'casa en Luque'));
  assert.equal(avisos(primero).length, 0);
  assert.equal(primero.state.derived, false);
  const bloqueo = repo.events(primero.state.leadId).find((e) => e.type === 'handoff_blocked');
  assert.deepEqual(bloqueo.payload.faltantes, ['presupuesto']);

  // El turno siguiente le avisa al LLM qué falta.
  const calls = h.fakeClaude(h.toolThenText({ datos: { presupuesto: 90000, moneda: 'USD' } }, 'Perfecto.'));
  const segundo = await adapter.handleMessage(msg(wa, 'hasta 90 mil dólares'));
  assert.match(calls[0].system[1].text, /Datos que faltan para pasar la consulta a un asesor: presupuesto/);
  assert.equal(avisos(segundo).length, 1);
  assert.equal(avisos(segundo)[0].payload.motivo, 'Lead calificado');
});

test('datos completos sin tag de cierre: todavía no deriva', async () => {
  equipo();
  const adapter = createTestAdapter();
  h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: COMPRA }, '¿Lo pagaría al contado o financiado?'));
  assert.equal(avisos(await adapter.handleMessage(msg(lead(), 'hola'))).length, 0);
});

test('pide hablar con una persona: deriva en el momento aunque falten datos', async () => {
  equipo();
  const adapter = createTestAdapter();
  h.fakeClaude(h.toolThenText({ flujo: 'alquiler', datos: { pide_humano: true } }, 'Le paso con una persona del equipo.'));
  const out = await adapter.handleMessage(msg(lead(), 'quiero hablar con alguien', ));
  assert.equal(avisos(out).length, 1);
  assert.equal(avisos(out)[0].payload.to, ANA.whatsapp);
  assert.equal(avisos(out)[0].payload.motivo, 'Pidió hablar con una persona (sin calificar)');

  // Sin flujo todavía → oficina.
  h.fakeClaude(h.toolThenText({ datos: { pide_humano: true } }, 'Le paso con una persona del equipo.'));
  const sinFlujo = await adapter.handleMessage(msg(lead(), 'pasame con una persona'));
  assert.equal(avisos(sinFlujo)[0].payload.to, OFICINA.whatsapp);
  assert.equal(avisos(sinFlujo)[0].payload.regla, 'oficina');
});

test('reclutamiento va al responsable; sin asesores para el flujo, a la oficina', async () => {
  equipo();
  const adapter = createTestAdapter();
  h.fakeClaude(h.toolThenText({ flujo: 'reclutamiento', datos: { nombre: 'Leo', ciudad: 'Luque', disponibilidad: 'parcial', entrevistaConfirmada: true } }, 'Listo. [AGENDA_ENTREVISTA]'));
  const rec = avisos(await adapter.handleMessage(msg(lead(), 'quiero ser asesor')))[0].payload;
  assert.equal(rec.to, RECLUTAMIENTO.whatsapp);
  assert.equal(rec.regla, 'reclutamiento');
  assert.equal(rec.params.flujo, 'Quiere ser asesor');

  // Nadie atiende captación → oficina.
  h.fakeClaude(h.toolThenText({ flujo: 'captacion', datos: { tipo: 'casa', zona: 'Luque' } }, 'Listo. [HANDOFF_PROPIETARIO]'));
  const cap = avisos(await adapter.handleMessage(msg(lead(), 'quiero vender mi casa')))[0].payload;
  assert.equal(cap.to, OFICINA.whatsapp);
  assert.equal(cap.regla, 'oficina');
  assert.match(cap.params.datos, /casa, Luque/);
});

test('propietario que quiere alquilar su propiedad: va a la oficina', async () => {
  equipo();
  const adapter = createTestAdapter();
  h.fakeClaude(h.toolThenText({ datos: { nombre: 'Rosa', tipo: 'casa', zona: 'Luque', derivar_oficina: true, observacion: 'Propietario quiere alquilar su propiedad' } }, 'Le paso su consulta a la oficina.'));
  const p = avisos(await adapter.handleMessage(msg(lead(), 'quiero poner en alquiler mi casa')))[0].payload;
  assert.equal(p.to, OFICINA.whatsapp);
  assert.equal(p.params.motivo, 'Consulta para la oficina');
  assert.equal(p.params.resumen, 'Propietario quiere alquilar su propiedad');
});

test('consulta por una propiedad del catálogo: compra califica con el nombre, sin presupuesto', async () => {
  equipo();
  const adapter = createTestAdapter();
  const prop = h.db.get().prepare('SELECT * FROM propiedades LIMIT 1').get();
  h.fakeClaude(h.toolThenText({ datos: { nombre: 'Luz', propiedad_id: prop.id } }, 'Le paso con un asesor. [HANDOFF_COMPRADOR]'));
  const out = await adapter.handleMessage(msg(lead(), 'me interesa esa propiedad'));
  assert.equal(out.state.qualified, true);
  const p = avisos(out)[0].payload;
  assert.match(p.params.resumen, new RegExp(`Consulta por ${prop.tipo}`));
  assert.ok(!/\n/.test(Object.values(p.params).join('')), 'las variables de la plantilla van en una sola línea');
});

test('el adapter de WhatsApp avisa por plantilla y, si falla, por mensaje común', async () => {
  equipo();
  const originalTemplate = whatsapp.sendTemplate;
  try {
    // Plantilla aprobada.
    h.openDb(h.tmpDbPath());
    let sent = h.captureSends();
    const plantillas = [];
    whatsapp.sendTemplate = async (to, nombre, idioma, params) => { plantillas.push({ to, nombre, idioma, params }); return { messages: [{ id: 'wamid.t' }] }; };
    h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: COMPRA }, 'Listo. [HANDOFF_COMPRADOR]'));
    let wa = lead();
    webhook.handlePayload(h.waPayload(wa, h.text('hola')));
    await agent.idle();
    assert.equal(plantillas.length, 1);
    assert.equal(plantillas[0].nombre, 'nuevo_lead_asesor');
    assert.equal(plantillas[0].params.telefono, `+${wa}`);
    assert.deepEqual(sent.map((s) => s.to), [wa]);
    assert.ok(repo.events(repo.getCurrentLead(wa).id).some((e) => e.type === 'advisor_notified' && e.payload.via === 'plantilla'));

    // Plantilla todavía sin aprobar: el aviso sale como texto.
    whatsapp.sendTemplate = async () => { throw new Error('WhatsApp API 404: template not found'); };
    sent = h.captureSends();
    h.fakeClaude(h.toolThenText({ flujo: 'compra', datos: COMPRA }, 'Listo. [HANDOFF_COMPRADOR]'));
    wa = lead();
    webhook.handlePayload(h.waPayload(wa, h.text('hola')));
    await agent.idle();
    assert.equal(sent.length, 2);
    const aviso = sent.find((s) => s.to !== wa);
    assert.match(aviso.text, /Nuevo lead de WhatsApp para atender\./);
    assert.match(aviso.text, new RegExp(`Teléfono: \\+${wa}`));
    assert.ok(repo.events(repo.getCurrentLead(wa).id).some((e) => e.type === 'advisor_notified' && e.payload.via === 'texto'));
  } finally {
    whatsapp.sendTemplate = originalTemplate;
  }
});

test('un número del equipo que le escribe al agente no es un lead', async () => {
  equipo();
  h.openDb(h.tmpDbPath());
  const calls = h.fakeClaude(h.toolThenText(null, 'Hola'));
  const sent = h.captureSends();
  webhook.handlePayload(h.waPayload(ANA.whatsapp, h.text('hola')));
  webhook.handlePayload(h.waPayload(OFICINA.whatsapp, h.text('hola')));
  await agent.idle();
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(h.db.get().prepare('SELECT COUNT(*) n FROM leads').get().n, 0);
});
