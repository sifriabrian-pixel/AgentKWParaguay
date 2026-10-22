// Panel con datos de ejemplo, para verlo en local sin tocar la base real.
//   node scripts/demo-panel.js   →  http://localhost:3020/conversaciones (clave: demo)
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-demo-')), 'kw.sqlite');
process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'demo';
process.env.PORT = process.env.PORT || '3020';

const db = require('../src/db');
const repo = require('../src/repo');
const config = require('../config/kw-py');
const { startServer } = require('../index');

db.open();
require('../src/catalogo').sync();

const natalia = config.asesores[0];
let n = 0;
function lead({ nombre, flujo, datos = {}, chat, derivar = false, anuncio = null, horasAtras = 2 }) {
  n += 1;
  const waId = `5959810${String(n).padStart(5, '0')}`;
  const l = repo.createLead(waId, { nombrePerfil: nombre, flujo });
  if (anuncio) repo.captureInbound(waId, nombre, { source_id: `AD${n}`, source_type: 'ad', headline: anuncio, ctwa_clid: `c${n}` });
  const base = Date.now() - horasAtras * 3600e3;
  chat.forEach(([dir, texto], i) => {
    const ts = new Date(base + i * 60e3).toISOString();
    db.get().prepare(`INSERT INTO messages (id, tenant_id, wa_id, lead_id, direction, wa_message_id, type, body, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?)`).run(`m${n}-${i}`, config.tenant_id, waId, l.id, dir, `wamid.demo.${n}.${i}`, texto, dir === 'in' ? 'procesado' : 'enviado', ts);
  });
  repo.updateLead(l.id, { datos: { nombre, ...datos } });
  if (derivar) {
    repo.markDerived(l.id, natalia.id);
    repo.addEvent(l.id, 'derived', { asesor_id: natalia.id, to: natalia.whatsapp, regla: 'flujo', motivo: 'Lead calificado' });
  }
}

const prop = db.get().prepare("SELECT id FROM propiedades WHERE direccion LIKE '%Cruz del Chaco%' LIMIT 1").get();
lead({ nombre: 'María López', flujo: 'compra', anuncio: 'Mova Recoleta — en pozo', datos: { propiedad_id: prop.id, tipo: 'departamento', zona: 'Recoleta, Asunción' }, derivar: true, horasAtras: 1,
  chat: [['in', 'Hola, me interesa la propiedad de Cruz del Chaco'], ['out', '¡Hola! Claro, le paso la info 👇 …'], ['in', 'Para comprar'], ['out', '¿Me dice su nombre?'], ['in', 'María López'], ['out', 'Perfecto, María 🙌 Le paso su consulta a un asesor…']] });
lead({ nombre: 'Jorge Benítez', flujo: 'alquiler', datos: { tipo: 'departamento', zona: 'Villa Morra', presupuesto: 4500000, moneda: 'PYG' }, horasAtras: 3,
  chat: [['in', 'Busco alquilar un depto en Villa Morra'], ['out', '¿Con qué presupuesto mensual cuenta?'], ['in', '4.500.000 guaraníes']] });
lead({ nombre: 'Lucía Giménez', flujo: 'compra', datos: { tipo: 'casa', zona: 'Luque' }, horasAtras: 5,
  chat: [['in', 'Quiero comprar una casa en Luque'], ['out', '¿Cuántos dormitorios necesita?']] });
lead({ nombre: 'Pedro Ortiz', flujo: 'captacion', datos: { operacion: 'venta', tipo: 'casa', zona: 'San Lorenzo' }, derivar: true, horasAtras: 26,
  chat: [['in', 'Quiero vender mi casa en San Lorenzo'], ['out', 'Perfecto, Pedro. Le paso su consulta a un asesor…']] });
lead({ nombre: 'Sofía Ramírez', flujo: 'reclutamiento', datos: { ciudad: 'Asunción', disponibilidad: 'completa' }, horasAtras: 50,
  chat: [['in', 'Quiero ser asesor de Keller Williams'], ['out', '¿Qué le motivó a interesarse por el rubro?']] });
lead({ nombre: 'Andrés Duarte', flujo: 'alquiler', anuncio: 'Alquileres en Asunción', datos: { tipo: 'departamento', zona: 'Asunción', presupuesto: 600, moneda: 'USD' }, derivar: true, horasAtras: 75,
  chat: [['in', '¡Hola! Quiero más información'], ['out', '¿Qué tipo de propiedad busca?'], ['in', 'Depto en Asunción, hasta 600 dólares']] });

startServer();
console.log(`[demo] Panel: http://localhost:${process.env.PORT}/conversaciones · clave: ${process.env.DASHBOARD_PASSWORD}`);
