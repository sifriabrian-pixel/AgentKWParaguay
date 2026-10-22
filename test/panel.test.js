const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const repo = require('../src/repo');
const panel = require('../src/panel');
const config = require('../config/kw-py');

const PASS = 'clave-panel';
const auth = (p = PASS) => `Basic ${Buffer.from(`kw:${p}`).toString('base64')}`;

function pedir(ruta, { authorization = auth() } = {}) {
  const url = new URL(ruta, 'http://localhost');
  const req = { method: 'GET', headers: authorization ? { authorization } : {} };
  const res = { status: null, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b || ''; } };
  const atendida = panel.handle(req, res, url);
  return { atendida, ...res };
}

let n = 0;
function crearLead({ nombre, flujo = null, datos = {}, mensajes = 1, derivarA = null }) {
  n += 1;
  const waId = `59598100${String(n).padStart(4, '0')}`;
  const lead = repo.createLead(waId, { nombrePerfil: nombre, flujo });
  for (let i = 0; i < mensajes; i++) repo.insertInbound({ waId, leadId: lead.id, waMessageId: `wamid.panel.${n}.${i}`, type: 'text', body: `hola ${i}` });
  repo.updateLead(lead.id, { datos: { nombre, ...datos } });
  if (derivarA) {
    repo.markDerived(lead.id, derivarA.id);
    repo.addEvent(lead.id, 'derived', { asesor_id: derivarA.id, to: derivarA.whatsapp, regla: 'flujo', motivo: 'Lead calificado' });
  }
  return repo.getLead(lead.id);
}

function preparar() {
  h.openDb(h.tmpDbPath());
  process.env.DASHBOARD_PASSWORD = PASS;
  config.asesores = [
    { id: 'ana', nombre: 'Ana Asesora', whatsapp: '595991000001', activa: true, flujos: ['compra', 'alquiler'] },
    { id: 'beto', nombre: 'Beto Asesor', whatsapp: '595991000002', activa: true, flujos: ['compra'] },
  ];
  const [ana, beto] = config.asesores;
  return {
    nuevo: crearLead({ nombre: 'Nora Nueva', flujo: 'compra', datos: { tipo: 'casa' } }),
    calificado: crearLead({ nombre: 'Carla Calificada', flujo: 'alquiler', datos: { tipo: 'depto', zona: 'Luque', presupuesto: 3000000, moneda: 'PYG' } }),
    d1: crearLead({ nombre: 'Dani', flujo: 'compra', datos: { tipo: 'casa', zona: 'Luque', presupuesto: 90000, moneda: 'USD' }, derivarA: ana }),
    d2: crearLead({ nombre: 'Dora', flujo: 'alquiler', datos: { tipo: 'depto', zona: 'Asunción', presupuesto: 500, moneda: 'USD' }, derivarA: ana }),
    d3: crearLead({ nombre: 'Dino', flujo: 'compra', datos: { tipo: 'terreno', zona: 'Lambaré', presupuesto: 50000, moneda: 'USD' }, derivarA: beto }),
    sinMensajes: crearLead({ nombre: 'Fantasma', flujo: 'compra', mensajes: 0 }),
  };
}

test('sin DASHBOARD_PASSWORD el panel no existe; con contraseña equivocada pide acceso', () => {
  preparar();
  delete process.env.DASHBOARD_PASSWORD;
  assert.equal(pedir('/conversaciones').atendida, false);
  process.env.DASHBOARD_PASSWORD = PASS;
  assert.equal(pedir('/stats', { authorization: null }).status, 401);
  assert.equal(pedir('/stats', { authorization: auth('otra') }).status, 401);
  assert.equal(pedir('/stats').status, 200);
});

test('Chats: cada lead cae en su columna y los leads sin mensajes no aparecen', () => {
  const l = preparar();
  assert.equal(panel.columna(l.nuevo), 'nuevos');
  assert.equal(panel.columna(l.calificado), 'calificados');
  assert.equal(panel.columna(l.d1), 'derivados');
  const { status, body } = pedir('/conversaciones');
  assert.equal(status, 200);
  const col = (clase) => body.split(`<section class="col ${clase}">`)[1].split('</section>')[0];
  assert.match(col('nuevos'), /Nora Nueva/);
  assert.match(col('calificados'), /Carla Calificada/);
  assert.match(col('derivados'), /Dani/);
  assert.match(col('derivados'), /→ Ana Asesora/);
  assert.doesNotMatch(body, /Fantasma/);
});

test('Stats: cuenta los leads que recibió cada asesor', () => {
  preparar();
  const { body } = pedir('/stats?dias=30');
  const fila = (nombre) => body.split(`<b>${nombre}</b>`)[1].split('</tr>')[0];
  const nums = (f) => [...f.matchAll(/<td class="num">(?:<b>)?(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(nums(fila('Ana Asesora')), [2, 1, 1, 0, 0, 0]);
  assert.deepEqual(nums(fila('Beto Asesor')), [1, 1, 0, 0, 0, 0]);
  assert.match(body, /<div class="v">5<\/div><div class="l">Leads atendidos/);
  assert.match(body, /<div class="v">3<\/div><div class="l">Derivados a un asesor/);
});

test('el detalle muestra la conversación y escapa lo que escribe el cliente', () => {
  preparar();
  const lead = crearLead({ nombre: '<script>alert(1)</script>', flujo: 'compra' });
  repo.insertInbound({ waId: lead.wa_id, leadId: lead.id, waMessageId: 'wamid.xss', type: 'text', body: '<img src=x onerror=alert(1)>' });
  const { status, body } = pedir(`/conversaciones/chat?id=${lead.id}`);
  assert.equal(status, 200);
  assert.doesNotMatch(body, /<script>alert/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(pedir('/conversaciones/chat?id=no-existe').status, 404);
});
