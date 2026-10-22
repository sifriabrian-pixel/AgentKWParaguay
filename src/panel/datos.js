// Datos del panel, leídos en vivo de la base del agente (SQLite).
//
// Arma el mismo "modelo" que el panel Sifer v2 arma desde memory.json +
// stats.json (Diamond e Impacta), para que las pantallas sean idénticas:
// un lead por número de WhatsApp, con su historial, eventos, derivación,
// marca y nota. Las marcas, notas y reasignaciones se guardan en la base.
const crypto = require('crypto');
const db = require('../db');
const config = require('../../config/kw-py');
const catalogo = require('../catalogo');
const { calificacion } = require('../calificacion');
const { pendiente } = require('../../prompts/kw-py');

const T = config.tenant_id;
const digitos = (s) => String(s || '').replace(/\D/g, '');

// Categorías de "Qué busca", en el orden en que se muestran.
const OPERACIONES = [
  'Compra', 'Alquiler', 'Consulta por una propiedad', 'Vender su propiedad', 'Alquilar su propiedad',
  'Pidió hablar con una persona', 'Quiere ser asesor', 'Sin clasificar',
];

// Flujos de KW → nombres que usa el panel v2 (los postulantes son 'asesor').
const FLUJO_PANEL = { compra: 'comprador', alquiler: 'arrendatario', captacion: 'propietario', reclutamiento: 'asesor' };

const OFICINA_ID = '__oficina__';

// "Backup oficina", "Oficina", "Reclutamiento", un número... no son personas.
const NO_ES_PERSONA = /backup|oficina|recepci|reclutamiento|guardia|general|administraci|\bequipo\b|^\+?\d+$/i;
const esPersona = (nombre) => !!String(nombre || '').trim() && !NO_ES_PERSONA.test(String(nombre).trim());

// ── Equipo (de config/kw-py.js) ──────────────────────────────────────────

function equipo() {
  const lista = [];
  const vistos = new Set();
  const sumar = (id, p) => {
    if (!p || pendiente(p.whatsapp)) return;
    const tel = digitos(p.whatsapp);
    if (vistos.has(tel)) return;
    vistos.add(tel);
    lista.push({ id, nombre: p.nombre, telefono: tel, activo: p.activa !== false });
  };
  for (const a of config.asesores || []) sumar(a.id, a);
  sumar('reclutamiento', config.reclutamiento);
  return lista;
}

function nombrePorTelefono(tel) {
  const n = digitos(tel);
  if (config.oficina && !pendiente(config.oficina.whatsapp) && digitos(config.oficina.whatsapp) === n
      && !equipo().some((p) => p.telefono === n)) return 'Oficina';
  const p = equipo().find((x) => x.telefono === n);
  return p ? p.nombre : (n ? `+${n}` : null);
}

function asesoresActivos() {
  return equipo().filter((a) => a.activo).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

// ── Lectura ──────────────────────────────────────────────────────────────

const ESTADOS_ENVIO = new Set(['enviado', 'entregado', 'leido', 'fallido']);

function dinero(monto, moneda) {
  if (!monto) return null;
  const n = Number(monto).toLocaleString('es-PY');
  return moneda === 'PYG' ? `Gs. ${n}` : `${moneda || ''} ${n}`.trim();
}

function operacion(flujo, d) {
  if (d.pide_humano && !flujo) return 'Pidió hablar con una persona';
  if (d.derivar_oficina && !flujo) return 'Alquilar su propiedad';
  if (d.propiedad_id && (flujo === 'compra' || flujo === 'alquiler' || !flujo)) return 'Consulta por una propiedad';
  switch (flujo) {
    case 'compra': return 'Compra';
    case 'alquiler': return 'Alquiler';
    case 'captacion': return 'Vender su propiedad';
    case 'reclutamiento': return 'Quiere ser asesor';
    default: return 'Sin clasificar';
  }
}

// Datos capturados, con nombres legibles para la ficha.
function datosLegibles(d) {
  const prop = d.propiedad_id ? catalogo.get(d.propiedad_id) : null;
  const out = {};
  const poner = (k, v) => { if (v != null && v !== '' && v !== false) out[k] = v; };
  poner('nombre', d.nombre);
  if (prop) poner('propiedad', `${prop.tipo} · ${[prop.barrio, prop.ciudad].filter(Boolean).join(', ')} · ${dinero(prop.precio, prop.moneda)}`);
  poner('tipo', d.tipo);
  poner('zona', d.zona);
  poner('dormitorios', d.dormitorios);
  poner('presupuesto', dinero(d.presupuesto, d.moneda));
  poner('fecha de mudanza', d.fechaMudanza);
  poner('operación', d.operacion);
  poner('ciudad', d.ciudad);
  poner('disponibilidad', d.disponibilidad);
  poner('experiencia', d.experiencia);
  if (d.entrevistaConfirmada === true) poner('entrevista', 'confirmada');
  if (d.descalificado === true) poner('descalificado', 'sí');
  if (d.pide_humano === true) poner('pidió hablar con una persona', 'sí');
  if (d.derivar_oficina === true) poner('para la oficina', 'sí');
  poner('observación', d.observacion);
  return out;
}

function parseJson(s, porDefecto) {
  try { return s ? JSON.parse(s) : porDefecto; } catch { return porDefecto; }
}

function cargar(cliente) {
  const conn = db.get();
  // Las conversaciones cerradas por #reiniciar son pruebas: no se muestran.
  const filas = conn.prepare(`
    SELECT * FROM leads WHERE tenant_id = ? AND status <> 'cerrado' ORDER BY created_at, rowid
  `).all(T);
  const porWa = new Map();
  for (const f of filas) {
    if (!porWa.has(f.wa_id)) porWa.set(f.wa_id, []);
    porWa.get(f.wa_id).push({ ...f, datos: parseJson(f.datos, {}), referral: parseJson(f.referral, null) });
  }

  const msgsStmt = conn.prepare(`
    SELECT lead_id, direction, body, status, created_at FROM messages
    WHERE tenant_id = ? AND body IS NOT NULL ORDER BY created_at, rowid
  `);
  const msgsPorLead = new Map();
  for (const m of msgsStmt.all(T)) {
    if (!msgsPorLead.has(m.lead_id)) msgsPorLead.set(m.lead_id, []);
    msgsPorLead.get(m.lead_id).push(m);
  }
  const evStmt = conn.prepare('SELECT lead_id, type, payload, created_at FROM lead_events WHERE tenant_id = ? ORDER BY created_at, rowid');
  const evPorLead = new Map();
  for (const e of evStmt.all(T)) {
    if (!evPorLead.has(e.lead_id)) evPorLead.set(e.lead_id, []);
    evPorLead.get(e.lead_id).push(e);
  }

  const leads = [];
  const eventosModelo = [];
  let ultimoDato = '';

  for (const [numero, grupo] of porWa) {
    const msgs = grupo.flatMap((l) => msgsPorLead.get(l.id) || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!msgs.some((m) => m.direction === 'in')) continue;
    // El registro actual del número (si abrió un segundo flujo, el último).
    const lead = grupo[grupo.length - 1];
    const derivadoReg = [...grupo].reverse().find((l) => l.derived_at) || null;
    const d = lead.datos;

    const eventos = grupo.flatMap((l) => (evPorLead.get(l.id) || []).map((e) => {
      const p = parseJson(e.payload, {}) || {};
      return { ...p, tipo: e.type, fecha: e.created_at, numero, origen: p.origen === 'panel' ? 'panel' : 'agente' };
    })).sort((a, b) => a.fecha.localeCompare(b.fecha));
    eventosModelo.push(...eventos);

    const historial = msgs.map((m) => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.body,
      ts: m.created_at,
      estadoEnvio: m.direction === 'out' && ESTADOS_ENVIO.has(m.status) ? m.status : undefined,
    }));
    const ultimoMensaje = msgs[msgs.length - 1].created_at;
    if (ultimoMensaje > ultimoDato) ultimoDato = ultimoMensaje;

    // Asesor: el último cambio desde el panel o, si no hubo, la derivación del agente.
    const reasignado = [...eventos].reverse().find((e) => e.tipo === 'reassigned');
    const derivacion = [...eventos].reverse().find((e) => e.tipo === 'derived');
    const asesor = reasignado ? (reasignado.to?.nombre || null) : (derivacion ? nombrePorTelefono(derivacion.to) : null);
    const asesorId = reasignado ? (reasignado.to?.id || null) : (derivacion?.asesor_id === 'oficina' ? OFICINA_ID : derivacion?.asesor_id || null);

    const flujo = lead.flujo || derivadoReg?.flujo || null;
    const origen = (() => {
      const conAnuncio = grupo.find((l) => l.source === 'ctwa');
      if (!conAnuncio) return null;
      const r = conAnuncio.referral || {};
      return { fuente: r.source_type === 'post' ? 'post' : 'anuncio', titulo: conAnuncio.campaign_name || r.headline || r.body || null, url: r.source_url || null };
    })();

    // Calificado: el mismo criterio con el que deriva el agente (config/kw-py.js).
    const cal = calificacion(flujo, d);
    const ultimoDelLead = [...historial].reverse().find((m) => m.role === 'user');
    let calificado = !!derivadoReg || cal.qualified;
    let motivo = null;
    if (d.pide_humano === true) { calificado = true; motivo = 'Pidió hablar con una persona'; }
    else if (d.derivar_oficina === true && !flujo) { calificado = true; motivo = 'Consulta para la oficina'; }
    else if (calificado) motivo = d.propiedad_id ? 'Consultó por una propiedad y dejó sus datos' : 'Tiene los datos para pasar a un asesor';

    leads.push({
      numero,
      nombre: d.nombre || lead.nombre_perfil || '',
      flujo: FLUJO_PANEL[flujo] || null,
      datos: datosLegibles(d),
      prioridad: lead.panel_prioridad || null,
      prioridadManual: !!lead.panel_prioridad,
      nota: lead.panel_nota || '',
      notaAutomatica: '',
      origen,
      historial,
      ultimoMensaje,
      creadoEn: grupo[0].created_at,
      historialCompleto: true,
      derivado: !!derivadoReg,
      derivadoEn: derivadoReg?.derived_at || null,
      derivacionRetroactiva: false,
      tipoDerivacion: derivadoReg ? 'derived' : null,
      asesor,
      asesorId,
      fueraCobertura: false,
      zona: cliente.clasificarZona(d),
      operacion: operacion(flujo, d),
      eventos,
      calificado,
      calificadoEn: calificado ? (derivacion?.fecha || ultimoDelLead?.ts || ultimoMensaje) : null,
      motivoCalificacion: motivo,
      tipoCalificado: calificado ? (flujo === 'reclutamiento' ? 'asesor' : 'cliente') : null,
      leadId: lead.id,
    });
  }

  const instalado = conn.prepare('SELECT MIN(created_at) AS f FROM leads WHERE tenant_id = ?').get(T)?.f || null;
  return {
    cliente,
    leads,
    porNumero: new Map(leads.map((l) => [l.numero, l])),
    eventos: eventosModelo,
    instaladoDesde: instalado,
    panelDesde: null,
    ultimoDato,
  };
}

// ── Escrituras del panel ─────────────────────────────────────────────────

function leadActual(numero) {
  return db.get().prepare(`
    SELECT * FROM leads WHERE tenant_id = ? AND wa_id = ? AND status <> 'cerrado' ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(T, numero) || null;
}

function evento(leadId, tipo, payload) {
  db.get().prepare('INSERT INTO lead_events (id, tenant_id, lead_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), T, leadId, tipo, JSON.stringify({ ...payload, origen: 'panel' }), new Date().toISOString());
}

const TIPO_POR_MARCA = {
  urgente: 'marked_urgent',
  atendido: 'marked_attended',
  asignado: 'marked_assigned',
  descartado: 'marked_discarded',
  '': 'mark_removed',
};

function marcar(_clienteId, numero, prioridad, usuario) {
  if (!(prioridad in TIPO_POR_MARCA)) throw new Error('Marca inválida');
  const lead = leadActual(numero);
  if (!lead) throw new Error('Lead inexistente');
  db.get().prepare('UPDATE leads SET panel_prioridad = ?, updated_at = ? WHERE id = ?').run(prioridad || null, new Date().toISOString(), lead.id);
  evento(lead.id, TIPO_POR_MARCA[prioridad], { anterior: lead.panel_prioridad || null, usuario: usuario || null });
}

function guardarNota(_clienteId, numero, nota, usuario) {
  const lead = leadActual(numero);
  if (!lead) throw new Error('Lead inexistente');
  const texto = String(nota || '').trim().slice(0, 2000);
  if ((lead.panel_nota || '') === texto) return;
  db.get().prepare('UPDATE leads SET panel_nota = ?, updated_at = ? WHERE id = ?').run(texto, new Date().toISOString(), lead.id);
  evento(lead.id, 'note_added', { texto, usuario: usuario || null });
}

// Cambia el asesor desde el panel (asesorId vacío = sin asesor). Queda el
// evento 'reassigned' { from, to, usuario }.
// TODO: avisarle al asesor nuevo por WhatsApp con el mismo aviso de la derivación.
function cambiarAsesor(_clienteId, numero, asesorId, usuario) {
  const lead = leadActual(numero);
  if (!lead) throw new Error('Lead inexistente');
  const nuevo = !asesorId ? null
    : asesorId === OFICINA_ID ? { id: OFICINA_ID, nombre: 'Oficina' }
    : asesoresActivos().find((a) => a.id === asesorId);
  if (asesorId && !nuevo) throw new Error('Asesor inválido');

  const modelo = cargar(require('./clientes').CLIENTES.kw);
  const actual = modelo.porNumero.get(numero);
  const anterior = actual?.asesor ? { id: actual.asesorId || null, nombre: actual.asesor } : null;
  if ((anterior?.nombre || null) === (nuevo?.nombre || null)) return false;

  db.get().prepare('UPDATE leads SET asesor_id = ?, updated_at = ? WHERE id = ?').run(nuevo?.id || null, new Date().toISOString(), lead.id);
  evento(lead.id, 'reassigned', { from: anterior, to: nuevo ? { id: nuevo.id, nombre: nuevo.nombre } : null, usuario: usuario || null });
  return true;
}

module.exports = {
  cargar, marcar, guardarNota, cambiarAsesor, asesoresActivos, esPersona, OPERACIONES, OFICINA_ID,
};
