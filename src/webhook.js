// Procesa el payload del webhook de WhatsApp Cloud API.
const repo = require('./repo');
const agent = require('./agent');
const core = require('./core');
const ruteo = require('./ruteo');
const config = require('../config/kw-py');

const ESTADOS_WA = { sent: 'enviado', delivered: 'entregado', read: 'leido', failed: 'fallido' };
const IGNORAR = new Set(['reaction', 'system', 'ephemeral']);

// Devuelve la lista de wa_id con mensajes nuevos (para tests).
function handlePayload(payload) {
  const numeros = new Set();
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const perfiles = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || null]));

      for (const msg of value.messages || []) {
        const waId = msg.from;
        if (!waId) continue;
        // Asesores, oficina y reclutamiento no son leads: no se les responde.
        if (ruteo.esNumeroInterno(waId)) {
          console.log(`[webhook] Mensaje de un número del equipo ignorado: ${waId}`);
          continue;
        }

        // 1. Origen del lead: se guarda ANTES de mirar el tipo de mensaje y
        //    antes de cualquier llamada al LLM. Si el primer mensaje es un
        //    audio o un sticker, el anuncio igual queda registrado.
        // 2. Historial + filtro de duplicados (wa_message_id UNIQUE).
        const comando = config.pruebas?.reiniciar;
        if (comando && msg.type === 'text' && (msg.text?.body || '').trim().toLowerCase() === comando) {
          agent.reset(waId).catch((e) => console.error(`[pruebas] Error reiniciando ${waId}:`, e));
          continue;
        }
        const ignorado = IGNORAR.has(msg.type);
        const mediaId = ignorado ? null : agent.mediaIdOf(msg);
        const { nuevo } = core.ingest({
          conversationId: waId,
          from: waId,
          text: ignorado ? null : agent.describeInbound(msg),
          messageId: msg.id,
          type: msg.type,
          attachments: mediaId ? [{ type: msg.type, mediaId }] : [],
          metadata: { referral: msg.referral || null, profileName: perfiles[waId] || null },
        });
        if (ignorado) continue;
        if (!nuevo) {
          console.log(`[webhook] Mensaje duplicado ignorado: ${msg.id}`);
          continue;
        }
        numeros.add(waId);
      }

      for (const st of value.statuses || []) {
        const estado = ESTADOS_WA[st.status];
        if (estado && st.id) repo.setDeliveryStatus(st.id, estado);
      }
    }
  }

  // 3. Procesar (de a un mensaje por número; en segundo plano).
  for (const waId of numeros) agent.kick(waId);
  return [...numeros];
}

module.exports = { handlePayload };
