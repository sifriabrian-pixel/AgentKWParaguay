const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const h = require('./helpers');
const repo = require('../src/repo');
const panel = require('../src/panel');
const datos = require('../src/panel/datos');
const { CLIENTES } = require('../src/panel/clientes');
const config = require('../config/kw-py');

const auth = (p) => `Basic ${Buffer.from(`kw:${p}`).toString('base64')}`;

async function pedir(ruta, { pass = 'equipo', method = 'GET', body = null, accept = '' } = {}) {
  const url = new URL(ruta, 'http://localhost');
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.headers = { ...(pass ? { authorization: auth(pass) } : {}), ...(accept ? { accept } : {}) };
  const res = { status: null, headers: {}, body: '', writeHead(s, hd) { this.status = s; this.headers = hd || {}; }, end(b) { this.body = b || ''; } };
  const atendida = await panel.handle(req, res, url);
  return { atendida, ...res };
}

let n = 0;
function crearLead({ nombre, flujo = null, datos: d = {}, mensajes = 1, derivarA = null }) {
  n += 1;
  const waId = `59598100${String(n).padStart(4, '0')}`;
  const lead = repo.createLead(waId, { nombrePerfil: nombre, flujo });
  for (let i = 0; i < mensajes; i++) repo.insertInbound({ waId, leadId: lead.id, waMessageId: `wamid.p.${n}.${i}`, type: 'text', body: `hola ${i}` });
  repo.updateLead(lead.id, { datos: { nombre, ...d } });
  if (derivarA) {
    repo.markDerived(lead.id, derivarA.id);
    repo.addEvent(lead.id, 'derived', { asesor_id: derivarA.id, to: derivarA.whatsapp, regla: 'flujo', motivo: 'Lead calificado' });
  }
  return repo.getLead(lead.id);
}

function preparar() {
  h.openDb(h.tmpDbPath());
  process.env.DASHBOARD_PASSWORD = 'equipo';
  process.env.ADMIN_PASSWORD = 'sifer';
  config.asesores = [
    { id: 'ana', nombre: 'Ana Asesora', whatsapp: '595991000001', activa: true, flujos: ['compra', 'alquiler'] },
    { id: 'beto', nombre: 'Beto Asesor', whatsapp: '595991000002', activa: true, flujos: ['compra'] },
  ];
  const [ana, beto] = config.asesores;
  return {
    nuevo: crearLead({ nombre: 'Nora Nueva', flujo: 'compra', datos: { tipo: 'casa' } }),
    calificado: crearLead({ nombre: 'Carla Calificada', flujo: 'alquiler', datos: { tipo: 'depto', zona: 'Luque', presupuesto: 3000000, moneda: 'PYG' } }),
    d1: crearLead({ nombre: 'Dani', flujo: 'compra', datos: { tipo: 'casa', zona: 'Recoleta', presupuesto: 90000, moneda: 'USD' }, derivarA: ana }),
    d2: crearLead({ nombre: 'Dora', flujo: 'alquiler', datos: { tipo: 'depto', zona: 'Asunción', presupuesto: 500, moneda: 'USD' }, derivarA: ana }),
    d3: crearLead({ nombre: 'Dino', flujo: 'compra', datos: { tipo: 'terreno', zona: 'Lambaré', presupuesto: 50000, moneda: 'USD' }, derivarA: beto }),
    sinMensajes: crearLead({ nombre: 'Fantasma', flujo: 'compra', mensajes: 0 }),
  };
}

test('sin contraseñas el panel no existe; sin clave correcta pide acceso; Salud es solo para Sifer', async () => {
  preparar();
  delete process.env.DASHBOARD_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  assert.equal((await pedir('/kw/leads')).atendida, false);
  process.env.DASHBOARD_PASSWORD = 'equipo';
  process.env.ADMIN_PASSWORD = 'sifer';
  assert.equal((await pedir('/kw/leads', { pass: null })).status, 401);
  assert.equal((await pedir('/kw/leads', { pass: 'otra' })).status, 401);
  assert.equal((await pedir('/kw/leads')).status, 200);
  assert.equal((await pedir('/kw/salud')).status, 404);
  assert.equal((await pedir('/kw/salud', { pass: 'sifer' })).status, 200);
  // Los links viejos del panel de Sifer siguen funcionando.
  assert.equal((await pedir('/conversaciones')).headers.Location, '/kw/leads');
  assert.equal((await pedir('/stats')).headers.Location, '/kw/resumen');
});

test('el modelo arma un lead por número con etapa, asesor y zona', () => {
  preparar();
  const m = datos.cargar(CLIENTES.kw);
  const por = (nombre) => m.leads.find((l) => l.nombre === nombre);
  assert.equal(m.leads.length, 5); // el lead sin mensajes no aparece
  assert.equal(por('Nora Nueva').calificado, false);
  assert.equal(por('Carla Calificada').calificado, true);
  assert.equal(por('Carla Calificada').derivado, false);
  assert.equal(por('Dani').derivado, true);
  assert.equal(por('Dani').asesor, 'Ana Asesora');
  assert.equal(por('Dani').zona, 'Asunción');
  assert.equal(por('Carla Calificada').zona, 'Gran Asunción');
  assert.equal(por('Dani').datos.presupuesto, 'USD 90.000');
});

test('Leads (kanban) muestra cada lead en su columna; Resumen cuenta derivaciones por asesor', async () => {
  preparar();
  const { body } = await pedir('/kw/leads');
  const col = (label) => body.split(`aria-label="${label}"`)[1].split('</section>')[0];
  assert.match(col('Conversando'), /Nora Nueva/);
  assert.match(col('Calificado'), /Carla Calificada/);
  assert.match(col('Derivado'), /Dani/);
  assert.doesNotMatch(body, /Fantasma/);

  const r = (await pedir('/kw/resumen?p=30')).body;
  const fila = (nombre) => r.split(`data-l="Asesor">${nombre}</td>`)[1].split('</tr>')[0];
  assert.match(fila('Ana Asesora'), /data-l="Derivados">2</);
  assert.match(fila('Beto Asesor'), /data-l="Derivados">1</);
  assert.match(r, /Valor de Asistente KW/);
});

test('marcas, notas y reasignación se guardan en la base y quedan en la historia', async () => {
  const l = preparar();
  const wa = l.d1.wa_id;
  let r = await pedir('/kw/marcar', { method: 'POST', body: `numero=${wa}&prioridad=urgente&volver=/kw/leads` });
  assert.equal(r.status, 303);
  r = await pedir('/kw/nota', { method: 'POST', body: `numero=${wa}&nota=${encodeURIComponent('Llamar el lunes')}&volver=/kw/leads` });
  r = await pedir('/kw/asesor', { method: 'POST', body: `numero=${wa}&asesor=beto`, accept: 'application/json' });
  assert.deepEqual(JSON.parse(r.body), { ok: true, usuario: 'Equipo KW' });

  const lead = datos.cargar(CLIENTES.kw).porNumero.get(wa);
  assert.equal(lead.prioridad, 'urgente');
  assert.equal(lead.nota, 'Llamar el lunes');
  assert.equal(lead.asesor, 'Beto Asesor');
  const tipos = lead.eventos.filter((e) => e.origen === 'panel').map((e) => e.tipo);
  assert.deepEqual(tipos, ['marked_urgent', 'note_added', 'reassigned']);

  const ficha = (await pedir(`/kw/leads?numero=${wa}`)).body;
  assert.match(ficha, /Reasignado: Ana Asesora → Beto Asesor · por Equipo KW/);
  assert.match(ficha, /Llamar el lunes/);
});

test('la ficha escapa lo que escribe el cliente y el CSV sale con los leads', async () => {
  preparar();
  const lead = crearLead({ nombre: '<script>alert(1)</script>', flujo: 'compra' });
  repo.insertInbound({ waId: lead.wa_id, leadId: lead.id, waMessageId: 'wamid.xss', type: 'text', body: '<img src=x onerror=alert(1)>' });
  const { body } = await pedir(`/kw/leads?numero=${lead.wa_id}`);
  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /<img src=x/);
  const csv = (await pedir('/kw/leads.csv')).body;
  assert.match(csv, /Dani/);
  assert.match(csv, /Carla Calificada/);
});
