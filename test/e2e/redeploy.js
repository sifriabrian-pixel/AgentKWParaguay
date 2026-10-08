// Prueba de punta a punta del criterio de cierre de la Fase 1:
// servidor real por HTTP, se mata el proceso a mitad de un turno (como un
// redeploy brusco) y se vuelve a levantar sobre la misma base.
//   node test/e2e/redeploy.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3999;
const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-e2e-')), 'kw.sqlite');
const WA = '595981777777';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start() {
  const proc = spawn(process.execPath, ['-r', './test/e2e/fake-claude-preload.js', 'index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT, DB_PATH, WHATSAPP_DRY_RUN: '1', WHATSAPP_VERIFY_TOKEN: 'v', ANTHROPIC_API_KEY: 'fake', WHATSAPP_APP_SECRET: '', META_SYSTEM_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`   [srv] ${d}`));
  proc.stderr.on('data', (d) => process.stdout.write(`   [srv!] ${d}`));
  return proc;
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch { /* todavía no */ }
    await sleep(100);
  }
  throw new Error('el servidor no levantó');
}

let n = 0;
async function send(body, extra = {}) {
  n += 1;
  const payload = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: WA, profile: { name: 'Luis' } }],
    messages: [{ from: WA, id: `wamid.e2e.${n}`, type: 'text', text: { body }, ...extra }],
  } }] }] };
  const res = await fetch(`http://localhost:${PORT}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(res.status, 200);
  return payload;
}

const q = (sql) => { const d = new Database(DB_PATH, { readonly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };

async function waitFor(cond, ms = 15000) {
  const hasta = Date.now() + ms;
  while (Date.now() < hasta) { if (cond()) return; await sleep(150); }
  throw new Error('timeout esperando condición');
}

(async () => {
  console.log('1) Arranca el servicio y entra un lead desde un anuncio');
  let srv = start();
  await waitUp();
  await send('Hola, quiero alquilar en Asunción, soy Luis', { referral: { source_id: 'AD123', source_type: 'ad', headline: 'Alquileres', ctwa_clid: 'clid1' } });
  await waitFor(() => q("SELECT 1 FROM messages WHERE direction='out' AND status='enviado'").length === 1);

  console.log('2) Llega el segundo mensaje y matamos el proceso mientras Claude "piensa"');
  const dup = await send('Busco un departamento');
  await sleep(300);
  srv.kill('SIGKILL');
  await sleep(500);
  assert.equal(q("SELECT * FROM messages WHERE direction='in' AND status='pendiente'").length, 1, 'el mensaje quedó guardado y pendiente');

  console.log('3) Redeploy: el servicio vuelve a levantar sobre la misma base');
  srv = start();
  await waitUp();
  await waitFor(() => q("SELECT 1 FROM messages WHERE direction='out' AND status='enviado'").length === 2);

  console.log('4) Meta reenvía el mismo mensaje (reintento del webhook) y sigue la charla');
  const res = await fetch(`http://localhost:${PORT}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dup) });
  assert.equal(res.status, 200);
  await send('¿Cuánto sale?');
  await waitFor(() => q("SELECT 1 FROM messages WHERE direction='out' AND status='enviado'").length === 3);
  srv.kill('SIGTERM');
  await sleep(800);
  if (srv.exitCode === null) srv.kill('SIGKILL');

  const leads = q('SELECT * FROM leads');
  const msgs = q('SELECT direction, status, body FROM messages ORDER BY created_at, rowid');
  console.log('\nResultado:');
  console.table(msgs);
  assert.equal(leads.length, 1, 'un solo lead');
  const lead = leads[0];
  assert.equal(lead.source, 'ctwa');
  assert.equal(lead.ad_id, 'AD123');
  assert.equal(lead.flujo, 'alquiler');
  assert.deepEqual(JSON.parse(lead.datos), { nombre: 'Luis', zona: 'Asunción', tipo: 'departamento' });
  assert.equal(msgs.filter((m) => m.direction === 'in').length, 3, 'sin entrantes duplicados');
  assert.equal(msgs.filter((m) => m.direction === 'out').length, 3, 'una respuesta por turno, sin duplicados');
  assert.equal(msgs.filter((m) => m.status === 'pendiente').length, 0);
  console.log('\nOK: sobrevivió al redeploy sin perder estado ni duplicar mensajes');
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
