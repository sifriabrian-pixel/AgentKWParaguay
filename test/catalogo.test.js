const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');

const catalogo = require('../src/catalogo');
const repo = require('../src/repo');
const agent = require('../src/agent');
const webhook = require('../src/webhook');

const ids = (res) => res.propiedades.map((p) => p.id);

test('el catálogo de prueba se carga y es idempotente', () => {
  h.openDb(h.tmpDbPath());
  assert.equal(catalogo.sync(), 10);
  assert.equal(catalogo.sync(), 10);
  assert.equal(h.db.get().prepare('SELECT COUNT(*) n FROM propiedades WHERE activo = 1').get().n, 10);
});

test('una propiedad que sale del archivo queda inactiva', () => {
  h.openDb(h.tmpDbPath());
  catalogo.sync();
  const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cat-')), 'cat.json');
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalogo', 'kw-py-prueba.json'), 'utf8')).slice(0, 3);
  fs.writeFileSync(archivo, JSON.stringify(items));
  catalogo.sync(archivo);
  assert.equal(catalogo.buscar({ operacion: 'venta' }).total, 3);
});

test('buscar: departamento en Recoleta incluye el monoambiente y ordena por precio', () => {
  h.openDb(h.tmpDbPath());
  catalogo.sync();
  const res = catalogo.buscar({ operacion: 'venta', tipo: 'departamento', zona: 'recoleta' });
  assert.deepEqual(ids(res), ['2165412433246526', '2165422816468416']);
});

test('buscar: el presupuesto filtra solo en la misma moneda, sin convertir', () => {
  h.openDb(h.tmpDbPath());
  catalogo.sync();
  const res = catalogo.buscar({ operacion: 'venta', tipo: 'departamento', zona: 'asuncion', presupuesto_max: 110000, moneda: 'USD' });
  assert.deepEqual(ids(res), ['2166394973882914', '2165412433246526', '2166472709797698']);
  assert.ok(res.propiedades.every((p) => p.precio <= 121000));

  const terreno = catalogo.buscar({ operacion: 'venta', tipo: 'terreno', zona: 'lambare', presupuesto_max: 800000000, moneda: 'PYG' });
  assert.deepEqual(ids(terreno), ['2166820126186482']);
  assert.equal(terreno.propiedades[0].moneda, 'PYG');
});

test('buscar: la zona busca también en la dirección y el resumen, sin tildes', () => {
  h.openDb(h.tmpDbPath());
  catalogo.sync();
  assert.deepEqual(ids(catalogo.buscar({ operacion: 'venta', zona: 'Villa Morra' })), ['2160068248033588']);
  assert.equal(catalogo.buscar({ operacion: 'venta', zona: 'Shopping del Sol' }).total, 3);
  assert.equal(catalogo.buscar({ operacion: 'alquiler' }).total, 0);
});

test('buscar: "Cruz del Chaco, Asunción" trae las dos unidades de esa calle y no todo Asunción', () => {
  h.openDb(h.tmpDbPath());
  catalogo.sync();
  assert.deepEqual(ids(catalogo.buscar({ zona: 'Cruz del Chaco, Asunción' })), ['2165412433246526', '2165422816468416']);
  assert.equal(catalogo.buscar({ zona: 'Mova del Sol' }).total, 3);
  assert.equal(catalogo.buscar({ zona: 'Calle Inexistente' }).total, 0);
});

test('consulta por propiedad puntual: propiedad_id completa tipo, zona y flujo con la ficha real', async () => {
  h.openDb(h.tmpDbPath());
  catalogo.sync();
  h.fakeClaude(h.toolThenText({ datos: { propiedad_id: '2165422816468416', proposito: 'inversion' } }, 'ok'));
  h.captureSends();
  webhook.handlePayload(h.waPayload('595981000098', h.text('Me interesa la propiedad de Cruz del Chaco')));
  await agent.idle();
  const lead = repo.getCurrentLead('595981000098');
  assert.equal(lead.flujo, 'compra');
  assert.deepEqual(lead.datos, { propiedad_id: '2165422816468416', proposito: 'inversion', tipo: 'departamento', zona: 'Recoleta, Asunción' });
  assert.ok(repo.events(lead.id).some((e) => e.type === 'propiedad_consultada' && e.payload.asesor_nombre === 'Maria de la Paz Ramirez'));
  assert.match(agent.buildContext(lead), /Consulta por esta propiedad: departamento en Recoleta/);
});

test('un propiedad_id que no existe en el catálogo se descarta', async () => {
  h.openDb(h.tmpDbPath());
  catalogo.sync();
  h.fakeClaude(h.toolThenText({ datos: { propiedad_id: 'inventado-123' } }, 'ok'));
  h.captureSends();
  webhook.handlePayload(h.waPayload('595981000097', h.text('hola')));
  await agent.idle();
  assert.equal(repo.getCurrentLead('595981000097').datos.propiedad_id, undefined);
});

test('el agente puede buscar propiedades y queda registrado qué se ofreció', async () => {
  h.openDb(h.tmpDbPath());
  catalogo.sync();
  let resultado = null;
  h.fakeClaude((params) => {
    const last = params.messages[params.messages.length - 1];
    if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
      resultado = last.content[0].content;
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tengo estas opciones…' }] };
    }
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tb1', name: 'buscar_propiedades', input: { operacion: 'venta', tipo: 'departamento', zona: 'Recoleta' } }] };
  });
  h.captureSends();
  webhook.handlePayload(h.waPayload('595981000099', h.text('Busco depto en Recoleta')));
  await agent.idle();

  const parsed = JSON.parse(resultado);
  assert.equal(parsed.total, 2);
  assert.match(parsed.propiedades[0].url, /^https:\/\/kwparaguay\.kw\.com\/property\//);
  const lead = repo.getCurrentLead('595981000099');
  const ev = repo.events(lead.id).find((e) => e.type === 'propiedades_buscadas');
  assert.deepEqual(ev.payload.ids, ['2165412433246526', '2165422816468416']);
});
