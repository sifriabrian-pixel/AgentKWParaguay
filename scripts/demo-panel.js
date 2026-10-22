// Panel con datos de ejemplo (unos 60 leads), para verlo en local sin tocar la base real.
//   node scripts/demo-panel.js  →  http://localhost:3020/kw/leads
//   clave del equipo: demo · clave de Sifer (ve Salud del agente): demo-admin
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-demo-')), 'kw.sqlite');
process.env.DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'demo';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'demo-admin';
process.env.PORT = process.env.PORT || '3020';

const db = require('../src/db');
const repo = require('../src/repo');
const config = require('../config/kw-py');
const { startServer } = require('../index');

db.open();
require('../src/catalogo').sync();
const conn = db.get();
const T = config.tenant_id;

// Generador determinístico, así el demo sale siempre igual.
let semilla = 7;
const azar = () => { semilla = (semilla * 16807) % 2147483647; return semilla / 2147483647; };
const uno = (lista) => lista[Math.floor(azar() * lista.length)];

const NOMBRES = ['María López', 'Jorge Benítez', 'Lucía Giménez', 'Pedro Ortiz', 'Sofía Ramírez', 'Andrés Duarte', 'Carla Villalba',
  'Diego Acosta', 'Laura Núñez', 'Martín Cáceres', 'Paola Riquelme', 'Hugo Ayala', 'Ana Franco', 'Raúl Méndez', 'Belén Sosa',
  'Fernando Torres', 'Rocío Báez', 'Gustavo Rojas', 'Nadia Insfrán', 'Iván Galeano'];
const ZONAS = ['Villa Morra', 'Recoleta', 'Las Lomas', 'Luque', 'Lambaré', 'San Lorenzo', 'Asunción centro', 'Fernando de la Mora', 'Encarnación'];
const props = conn.prepare('SELECT id FROM propiedades').all().map((p) => p.id);
const natalia = config.asesores[0];

function insertarMensaje(waId, leadId, dir, texto, ts, estado) {
  conn.prepare(`INSERT INTO messages (id, tenant_id, wa_id, lead_id, direction, wa_message_id, type, body, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?)`).run(crypto.randomUUID(), T, waId, leadId, dir, `wamid.demo.${crypto.randomUUID()}`, texto, estado, ts);
}

for (let i = 0; i < 60; i++) {
  const waId = `5959${String(81000000 + i * 137)}`;
  const nombre = uno(NOMBRES);
  const horasAtras = Math.round(azar() * 24 * 25);
  const inicio = Date.now() - horasAtras * 3600e3;
  const tipoCaso = uno(['compra', 'compra', 'alquiler', 'alquiler', 'puntual', 'puntual', 'captacion', 'reclutamiento', 'nuevo']);
  const flujo = { compra: 'compra', alquiler: 'alquiler', puntual: 'compra', captacion: 'captacion', reclutamiento: 'reclutamiento', nuevo: null }[tipoCaso];
  const lead = repo.createLead(waId, { nombrePerfil: nombre, flujo });
  conn.prepare('UPDATE leads SET created_at = ? WHERE id = ?').run(new Date(inicio).toISOString(), lead.id);
  if (tipoCaso === 'puntual' || azar() < 0.3) {
    repo.captureInbound(waId, nombre, { source_id: `AD${i % 4}`, source_type: 'ad', headline: uno(['Mova Recoleta — en pozo', 'Alquileres en Asunción', 'Casas en Luque', 'Sumate a Keller Williams']) });
  }

  const zona = uno(ZONAS);
  const completo = azar() < 0.65;
  const datos = { nombre };
  if (tipoCaso === 'compra') Object.assign(datos, { tipo: uno(['casa', 'departamento', 'terreno']), zona, dormitorios: uno(['2', '3']), ...(completo ? { presupuesto: uno([90000, 150000, 250000]), moneda: 'USD' } : {}) });
  if (tipoCaso === 'alquiler') Object.assign(datos, { tipo: 'departamento', zona, ...(completo ? { presupuesto: uno([3500000, 5000000]), moneda: 'PYG' } : {}) });
  if (tipoCaso === 'puntual') Object.assign(datos, { propiedad_id: uno(props), ...(completo ? {} : { nombre: undefined }) });
  if (tipoCaso === 'captacion') Object.assign(datos, { operacion: 'venta', tipo: 'casa', ...(completo ? { zona } : {}) });
  if (tipoCaso === 'reclutamiento') Object.assign(datos, { ciudad: uno(['Asunción', 'Luque', 'Encarnación']), disponibilidad: 'completa', ...(completo ? { entrevistaConfirmada: true } : {}) });
  repo.updateLead(lead.id, { datos });

  const charla = [['in', uno(['Hola, quiero info', 'Me interesa la propiedad del anuncio', 'Busco alquilar un depto', 'Quiero comprar una casa', 'Quiero ser asesor'])],
    ['out', '¡Hola! Con gusto le ayudo. ¿Me cuenta qué está buscando?'], ['in', `En ${zona}`], ['out', 'Perfecto, ¿con qué presupuesto cuenta?']];
  if (completo) charla.push(['in', 'Unos 150 mil dólares'], ['out', 'Perfecto 🙌 Le paso su consulta a un asesor de Keller Williams.']);
  charla.forEach(([dir, texto], k) => insertarMensaje(waId, lead.id, dir, texto, new Date(inicio + k * 45e3).toISOString(),
    dir === 'in' ? 'procesado' : uno(['leido', 'leido', 'entregado'])));

  if (completo && flujo) {
    repo.markDerived(lead.id, natalia.id);
    conn.prepare('UPDATE leads SET derived_at = ? WHERE id = ?').run(new Date(inicio + 5 * 60e3).toISOString(), lead.id);
    repo.addEvent(lead.id, 'derived', { asesor_id: natalia.id, to: natalia.whatsapp, regla: 'flujo', motivo: 'Lead calificado' });
    if (azar() < 0.3) conn.prepare('UPDATE leads SET panel_prioridad = ? WHERE id = ?').run(uno(['atendido', 'asignado']), lead.id);
  } else if (azar() < 0.15) {
    conn.prepare('UPDATE leads SET panel_prioridad = ?, panel_nota = ? WHERE id = ?').run(uno(['urgente', 'descartado']), 'No contesta, reintentar mañana', lead.id);
  }
}

startServer();
console.log(`[demo] Panel: http://localhost:${process.env.PORT}/kw/leads · clave equipo: ${process.env.DASHBOARD_PASSWORD} · clave Sifer: ${process.env.ADMIN_PASSWORD}`);
