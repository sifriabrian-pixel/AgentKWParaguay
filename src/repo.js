// Acceso a datos. Todo el estado del agente se lee y escribe acá; nada
// crítico queda en memoria del proceso.
const crypto = require('crypto');
const db = require('./db');
const clock = require('./clock');
const config = require('../config/kw-py');

const T = config.tenant_id;
const now = clock.nowISO;
const uuid = () => crypto.randomUUID();

function parseLead(row) {
  if (!row) return null;
  return {
    ...row,
    datos: JSON.parse(row.datos || '{}'),
    referral: row.referral ? JSON.parse(row.referral) : null,
  };
}

// ─── Leads ───────────────────────────────────────────────────────────────────

// Lead actual de un número = el último creado (un wa_id puede tener varios
// registros si el lead abrió un segundo flujo).
function getCurrentLead(waId) {
  return parseLead(db.get().prepare(
    'SELECT * FROM leads WHERE tenant_id = ? AND wa_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get(T, waId));
}

function getLead(id) {
  return parseLead(db.get().prepare('SELECT * FROM leads WHERE id = ?').get(id));
}

function createLead(waId, { nombrePerfil = null, flujo = null, datos = {} } = {}) {
  const id = uuid();
  const ts = now();
  const leadType = flujo ? config.flujos[flujo].lead_type : null;
  db.get().prepare(`
    INSERT INTO leads (id, tenant_id, wa_id, nombre_perfil, flujo, lead_type, datos, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, T, waId, nombrePerfil, flujo, leadType, JSON.stringify(datos), ts, ts);
  addEvent(id, 'created', { flujo });
  return getLead(id);
}

// Guarda el referral del anuncio (Click-to-WhatsApp) en el lead actual.
// Se llama ANTES de mirar el tipo de mensaje y antes de cualquier llamada al LLM.
// Devuelve el lead (creándolo si no existía).
function captureInbound(waId, nombrePerfil, referral) {
  const conn = db.get();
  return conn.transaction(() => {
    let lead = getCurrentLead(waId);
    if (!lead) lead = createLead(waId, { nombrePerfil });
    else if (nombrePerfil && !lead.nombre_perfil) {
      conn.prepare('UPDATE leads SET nombre_perfil = ?, updated_at = ? WHERE id = ?').run(nombrePerfil, now(), lead.id);
    }

    if (referral) {
      const adId = referral.source_id || null;
      if (!lead.referral) {
        conn.prepare(`
          UPDATE leads SET source = 'ctwa', ad_id = ?, referral = ?, ctwa_clid = ?, updated_at = ?
          WHERE id = ? AND referral IS NULL
        `).run(adId, JSON.stringify(referral), referral.ctwa_clid || null, now(), lead.id);
        addEvent(lead.id, 'referral_captured', { ad_id: adId, source_type: referral.source_type || null });
      } else if (lead.ad_id !== adId) {
        // Volvió desde otro anuncio: se registra sin pisar el origen original.
        addEvent(lead.id, 'referral_repeat', referral);
      }
    }
    return getCurrentLead(waId);
  })();
}

function updateLead(id, campos) {
  const permitidos = ['flujo', 'lead_type', 'datos', 'status', 'consent_at', 'last_inbound_at', 'last_outbound_at',
    'campaign_id', 'campaign_name', 'adset_name', 'ad_name', 'campaign_status', 'campaign_flujo', 'campaign_zona', 'campaign_asesor'];
  const claves = Object.keys(campos).filter((k) => permitidos.includes(k));
  if (claves.length === 0) return;
  const valores = claves.map((k) => (k === 'datos' ? JSON.stringify(campos[k]) : campos[k]));
  db.get().prepare(`UPDATE leads SET ${claves.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...valores, now(), id);
}

// Marca el lead como derivado. Devuelve false si ya lo estaba (se deriva una sola vez).
function markDerived(id, asesorId) {
  const ts = now();
  return db.get().prepare(`
    UPDATE leads SET derived_at = ?, status = 'derivado', asesor_id = ?, updated_at = ? WHERE id = ? AND derived_at IS NULL
  `).run(ts, asesorId, ts, id).changes === 1;
}

// Turnos entre asesores: devuelve el número de turno de ese grupo y lo avanza.
function nextTurn(poolKey) {
  const conn = db.get();
  return conn.transaction(() => {
    const row = conn.prepare('SELECT counter FROM asesor_rr WHERE tenant_id = ? AND pool_key = ?').get(T, poolKey);
    if (!row) {
      conn.prepare('INSERT INTO asesor_rr (tenant_id, pool_key, counter, updated_at) VALUES (?, ?, 1, ?)').run(T, poolKey, now());
      return 0;
    }
    conn.prepare('UPDATE asesor_rr SET counter = counter + 1, updated_at = ? WHERE tenant_id = ? AND pool_key = ?').run(now(), T, poolKey);
    return row.counter;
  })();
}

// Leads derivados cuyo aviso al asesor todavía no salió: falló (menos de
// maxIntentos veces) o el proceso se cortó antes de enviarlo.
function leadsSinAviso(maxIntentos, derivadosAntesDe) {
  return db.get().prepare(`
    SELECT l.*, (SELECT COUNT(*) FROM lead_events e WHERE e.lead_id = l.id AND e.type = 'advisor_notify_failed') AS fallos
    FROM leads l
    WHERE l.tenant_id = ? AND l.derived_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.type = 'advisor_notified')
  `).all(T).filter((l) => l.fallos < maxIntentos && (l.fallos > 0 || l.derived_at < derivadosAntesDe)).map(parseLead);
}

// Cache de anuncios: si otro lead ya resolvió este ad_id, se reutiliza.
function findResolvedAd(adId) {
  return db.get().prepare(`
    SELECT campaign_id, campaign_name, adset_name, ad_name FROM leads
    WHERE tenant_id = ? AND ad_id = ? AND campaign_name IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(T, adId) || null;
}

// ─── Mensajes ────────────────────────────────────────────────────────────────

// Inserta un mensaje entrante. wa_message_id UNIQUE hace de filtro de duplicados:
// devuelve false si Meta reenvió un mensaje que ya teníamos.
function insertInbound({ waId, leadId, waMessageId, type, body = null, mediaId = null }) {
  const res = db.get().prepare(`
    INSERT INTO messages (id, tenant_id, wa_id, lead_id, direction, wa_message_id, type, body, media_id, status, created_at)
    VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, 'pendiente', ?)
    ON CONFLICT (wa_message_id) DO NOTHING
  `).run(uuid(), T, waId, leadId, waMessageId, type, body, mediaId, now());
  if (res.changes === 0) return false;
  updateLead(leadId, { last_inbound_at: now() });
  return true;
}

function pendingInbound(waId) {
  return db.get().prepare(`
    SELECT * FROM messages WHERE tenant_id = ? AND wa_id = ? AND direction = 'in' AND status = 'pendiente'
    ORDER BY created_at, rowid
  `).all(T, waId);
}

function waIdsWithPending() {
  return db.get().prepare(`
    SELECT DISTINCT wa_id FROM messages WHERE tenant_id = ? AND direction = 'in' AND status = 'pendiente'
  `).all(T).map((r) => r.wa_id);
}

function bumpAttempts(ids) {
  const stmt = db.get().prepare('UPDATE messages SET attempts = attempts + 1 WHERE id = ?');
  db.get().transaction(() => ids.forEach((id) => stmt.run(id)))();
}

// Reinicio de pruebas: el número arranca de cero sin borrar nada. Los leads
// anteriores quedan cerrados, se crea uno nuevo y el historial que ve el
// agente empieza después de este punto.
function resetConversation(waId) {
  const conn = db.get();
  return conn.transaction(() => {
    const anterior = getCurrentLead(waId);
    conn.prepare("UPDATE messages SET status = 'procesado', processed_at = ? WHERE tenant_id = ? AND wa_id = ? AND direction = 'in' AND status = 'pendiente'").run(now(), T, waId);
    conn.prepare("UPDATE leads SET status = 'cerrado', updated_at = ? WHERE tenant_id = ? AND wa_id = ?").run(now(), T, waId);
    const desde = conn.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM messages WHERE tenant_id = ? AND wa_id = ?').get(T, waId).n;
    const nuevo = createLead(waId, { nombrePerfil: anterior?.nombre_perfil || null });
    addEvent(nuevo.id, 'conversation_reset', { desde_mensaje: desde, lead_anterior: anterior?.id || null });
    return nuevo;
  })();
}

function inicioHistorial(waId) {
  const row = db.get().prepare(`
    SELECT e.payload FROM lead_events e JOIN leads l ON l.id = e.lead_id
    WHERE l.tenant_id = ? AND l.wa_id = ? AND e.type = 'conversation_reset'
    ORDER BY e.rowid DESC LIMIT 1
  `).get(T, waId);
  return row ? JSON.parse(row.payload).desde_mensaje : 0;
}

// Últimos N mensajes de texto del número (entrantes y salientes), en orden.
function history(waId, limit = 40) {
  return db.get().prepare(`
    SELECT * FROM (
      SELECT rowid AS rid, * FROM messages
      WHERE tenant_id = ? AND wa_id = ? AND body IS NOT NULL AND rowid > ?
        AND NOT (direction = 'in' AND status = 'pendiente')
        AND NOT (direction = 'out' AND status IN ('fallido'))
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    ) ORDER BY created_at, rid
  `).all(T, waId, inicioHistorial(waId), limit);
}

// Cierra un turno de forma atómica: marca los entrantes como procesados y
// registra la respuesta saliente en estado 'enviando'. Si el proceso muere
// entre esto y el envío, al reiniciar no se vuelve a responder (sin duplicados).
function commitTurn({ waId, leadId, inboundIds, replyText, tags }) {
  const conn = db.get();
  const outId = uuid();
  const ts = now();
  conn.transaction(() => {
    const mark = conn.prepare("UPDATE messages SET status = 'procesado', processed_at = ? WHERE id = ?");
    inboundIds.forEach((id) => mark.run(ts, id));
    if (replyText) {
      conn.prepare(`
        INSERT INTO messages (id, tenant_id, wa_id, lead_id, direction, type, body, tags, status, created_at)
        VALUES (?, ?, ?, ?, 'out', 'text', ?, ?, 'enviando', ?)
      `).run(outId, T, waId, leadId, replyText, tags && tags.length ? JSON.stringify(tags) : null, ts);
    }
  })();
  return replyText ? outId : null;
}

function insertOutbound({ waId, leadId, type = 'text', body, status = 'enviando' }) {
  const id = uuid();
  db.get().prepare(`
    INSERT INTO messages (id, tenant_id, wa_id, lead_id, direction, type, body, status, created_at)
    VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?)
  `).run(id, T, waId, leadId, type, body, status, now());
  return id;
}

function markOutbound(id, status, waMessageId = null) {
  db.get().prepare('UPDATE messages SET status = ?, wa_message_id = COALESCE(?, wa_message_id) WHERE id = ?')
    .run(status, waMessageId, id);
}

const ORDEN_ESTADOS = { enviado: 1, entregado: 2, leido: 3 };

// Estados de entrega de Meta (sent/delivered/read/failed). No retrocede: un
// 'delivered' que llega tarde no pisa un 'read'.
function setDeliveryStatus(waMessageId, status) {
  const row = db.get().prepare("SELECT id, status FROM messages WHERE wa_message_id = ? AND direction = 'out'").get(waMessageId);
  if (!row) return;
  if (status !== 'fallido' && (ORDEN_ESTADOS[row.status] || 0) >= ORDEN_ESTADOS[status]) return;
  db.get().prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, row.id);
}

// Al arrancar: salientes que quedaron 'enviando' (el proceso murió en medio del
// envío). No se reenvían para no duplicar; quedan marcados para auditoría.
function markStuckOutbound() {
  return db.get().prepare("UPDATE messages SET status = 'desconocido' WHERE tenant_id = ? AND direction = 'out' AND status = 'enviando'")
    .run(T).changes;
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

function addEvent(leadId, type, payload = null) {
  db.get().prepare('INSERT INTO lead_events (id, tenant_id, lead_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), T, leadId, type, payload == null ? null : JSON.stringify(payload), now());
}

function events(leadId) {
  return db.get().prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY created_at, rowid').all(leadId)
    .map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
}

module.exports = {
  getCurrentLead, getLead, createLead, captureInbound, updateLead, markDerived, nextTurn, findResolvedAd,
  insertInbound, pendingInbound, waIdsWithPending, bumpAttempts, history, commitTurn, resetConversation, leadsSinAviso,
  insertOutbound, markOutbound, setDeliveryStatus, markStuckOutbound,
  addEvent, events,
};
