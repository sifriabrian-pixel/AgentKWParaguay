// Adapter de WhatsApp: ejecuta lo que decide el core (src/core.js).
//
// Flujo de un mensaje entrante:
//   webhook → core.ingest (referral ANTES de todo; wa_message_id UNIQUE = filtro
//   de duplicados) → agent.kick(waId) → core.processPending → envío por WhatsApp
//
// kick() procesa los mensajes pendientes de un número de a uno por vez (bloqueo
// por número). Si llegan varios seguidos se responden juntos en un solo turno.
// El estado vive en la base: si el proceso se reinicia, recover() retoma los
// mensajes que quedaron pendientes.
const repo = require('./repo');
const whatsapp = require('./whatsapp');
const core = require('./core');

const MAX_INTENTOS = 3;
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 20000);
const MSG_ERROR = 'Disculpe, tuvimos un inconveniente técnico. ¿Me podría escribir de nuevo en unos minutos?';

// ─── Texto que representa cada tipo de mensaje de WhatsApp ───────────────────
function describeInbound(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'button': return msg.button?.text || '[Tocó un botón]';
    case 'interactive':
      return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[Respondió un mensaje interactivo]';
    case 'image': return `[Envió una imagen${msg.image?.caption ? `: ${msg.image.caption}` : ''}]`;
    case 'document': return `[Envió un documento${msg.document?.filename ? `: ${msg.document.filename}` : ''}]`;
    case 'audio': return '[Envió un audio que no se puede escuchar]';
    case 'video': return '[Envió un video que no se puede ver]';
    case 'sticker': return '[Envió un sticker]';
    case 'location': return `[Envió una ubicación${msg.location?.name ? `: ${msg.location.name}` : ''}]`;
    default: return `[Envió un mensaje de tipo ${msg.type}]`;
  }
}

function mediaIdOf(msg) {
  return msg[msg.type]?.id || null;
}

// ─── Acciones del core ───────────────────────────────────────────────────────

// CV del postulante → responsable de reclutamiento.
async function forwardDocument({ leadId, waId, to, mediaType, mediaId, caption }) {
  try {
    await whatsapp.sendMedia(to, mediaType, mediaId, caption);
    repo.addEvent(leadId, 'document_forwarded', { media_id: mediaId, to });
  } catch (e) {
    console.error(`[cv] Error reenviando documento de ${waId}:`, e.message);
    repo.addEvent(leadId, 'document_forward_failed', { media_id: mediaId, error: e.message });
  }
}

async function runActions(actions) {
  for (const action of actions) {
    if (action.type === 'forward_document') await forwardDocument(action.payload);
    // 'handoff': los tags del LLM todavía no derivan (queda el evento llm_tag).
  }
}

// ─── Turno ───────────────────────────────────────────────────────────────────

// Devuelve true si el turno quedó cerrado; false si hay que reintentar más tarde.
async function processTurn(waId) {
  const out = await core.processPending(waId, undefined, {
    // Claude falló: se reintenta más tarde y al tercer error se manda una disculpa.
    onLlmError: (e, { lead, pendientes }) => {
      console.error(`[agent] Error de Claude para ${waId}:`, e.message);
      repo.bumpAttempts(pendientes.map((m) => m.id));
      const intentos = Math.max(...pendientes.map((m) => m.attempts)) + 1;
      repo.addEvent(lead.id, 'llm_error', { error: e.message, intento: intentos });
      if (intentos < MAX_INTENTOS) {
        setTimeout(() => kick(waId), RETRY_BASE_MS * intentos).unref();
        return null;
      }
      return MSG_ERROR;
    },
  });
  if (!out) return false;

  await runActions(out.actions);

  const [texto] = out.messages;
  const { leadId, outboundId } = out.meta;
  if (!texto) return true;
  try {
    const res = await whatsapp.sendMessage(waId, texto);
    repo.markOutbound(outboundId, 'enviado', res?.messages?.[0]?.id || null);
    repo.updateLead(leadId, { last_outbound_at: new Date().toISOString() });
  } catch (e) {
    console.error(`[wa] Error enviando a ${waId}:`, e.message);
    repo.markOutbound(outboundId, 'fallido');
    repo.addEvent(leadId, 'send_failed', { error: e.message });
  }
  return true;
}

// ─── Cola por número ─────────────────────────────────────────────────────────
// Una sola instancia del servicio: el bloqueo por número vive en el proceso,
// pero lo que bloquea son filas de la base, que sobreviven al reinicio.
const enCurso = new Map(); // waId → Promise

function kick(waId) {
  if (enCurso.has(waId)) {
    enCurso.get(waId).again = true;
    return enCurso.get(waId).promise;
  }
  const estado = { again: false, promise: null };
  estado.promise = (async () => {
    try {
      do {
        estado.again = false;
        if (!repo.pendingInbound(waId).length) break;
        const cerrado = await processTurn(waId);
        if (!cerrado) break; // reintento programado
      } while (estado.again || repo.pendingInbound(waId).length);
    } catch (e) {
      console.error(`[agent] Error procesando ${waId}:`, e);
    } finally {
      enCurso.delete(waId);
    }
  })();
  enCurso.set(waId, estado);
  return estado.promise;
}

// Al arrancar: retomar lo que quedó a mitad de camino.
function recover() {
  const trabados = repo.markStuckOutbound();
  if (trabados) console.warn(`[agent] ${trabados} mensaje(s) saliente(s) quedaron sin confirmar en el reinicio anterior`);
  const numeros = repo.waIdsWithPending();
  if (numeros.length) console.log(`[agent] Retomando ${numeros.length} conversación(es) con mensajes pendientes`);
  return Promise.all(numeros.map((n) => kick(n)));
}

function idle() {
  return Promise.all([...enCurso.values()].map((e) => e.promise));
}

const { extractTags, cleanTags, applyGuardarDatos, applyBuscarPropiedades, buildContext, toApiMessages } = core;

module.exports = { kick, recover, idle, describeInbound, mediaIdOf, extractTags, cleanTags, applyGuardarDatos, applyBuscarPropiedades, buildContext, toApiMessages };
