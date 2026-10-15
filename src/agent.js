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
// Antes de responder se espera a que el lead deje de escribir, para contestar
// juntos los mensajes que llegan seguidos.
const esperaMs = () => Number(process.env.ESPERA_MENSAJES_MS ?? 3000);
const MAX_AVISOS = 5;
const MSG_REINICIO = 'Conversación reiniciada. Puede empezar de nuevo.';
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

// Aviso al asesor. Va por plantilla (el asesor casi nunca está dentro de la
// ventana de 24 hs); si la plantilla falla, se intenta como mensaje común.
async function notifyAdvisor({ leadId, waId, to, template, idioma, params, texto }) {
  try {
    await whatsapp.sendTemplate(to, template, idioma, params);
    repo.addEvent(leadId, 'advisor_notified', { to, via: 'plantilla' });
  } catch (ePlantilla) {
    try {
      await whatsapp.sendMessage(to, texto);
      repo.addEvent(leadId, 'advisor_notified', { to, via: 'texto', error_plantilla: ePlantilla.message });
    } catch (eTexto) {
      console.error(`[derivacion] No se pudo avisar a ${to} por el lead ${waId}:`, eTexto.message);
      repo.addEvent(leadId, 'advisor_notify_failed', { to, error_plantilla: ePlantilla.message, error_texto: eTexto.message });
    }
  }
}

// Avisos que no salieron (falló el envío o el proceso se cortó): se vuelven a
// intentar al arrancar y cada pocos minutos, hasta MAX_AVISOS veces por lead.
let reintentando = false;
async function retryNotices() {
  if (reintentando) return 0;
  reintentando = true;
  try {
    const hace2min = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const leads = repo.leadsSinAviso(MAX_AVISOS, hace2min);
    for (const lead of leads) {
      const derivado = repo.events(lead.id).filter((e) => e.type === 'derived').pop();
      if (!derivado) continue;
      const { asesor_id: asesorId, to, regla, motivo, qualified } = derivado.payload;
      await notifyAdvisor(core.avisoPayload(lead, { to, asesorId, regla, motivo, qualified }));
    }
    return leads.length;
  } finally {
    reintentando = false;
  }
}

async function runActions(actions) {
  for (const action of actions) {
    if (action.type === 'forward_document') await forwardDocument(action.payload);
    if (action.type === 'notify_advisor') await notifyAdvisor(action.payload);
    // 'handoff' es solo informativo: el LLM pidió cerrar. Derivar lo decide el core.
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
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera hasta que pase ese tiempo sin mensajes nuevos de ese número (con tope).
async function esperarSilencio(waId) {
  const espera = esperaMs();
  if (!espera) return;
  const tope = Date.now() + espera * 4;
  let cantidad = repo.pendingInbound(waId).length;
  for (;;) {
    await dormir(espera);
    const ahora = repo.pendingInbound(waId).length;
    if (ahora === cantidad || Date.now() >= tope) return;
    cantidad = ahora;
  }
}

// "Escribiendo…" en el WhatsApp del cliente mientras se arma la respuesta.
// Va sobre el último mensaje pendiente. Si falla no frena nada.
function mostrarEscribiendo(waId) {
  const pendientes = repo.pendingInbound(waId);
  const ultimo = pendientes[pendientes.length - 1];
  if (!ultimo?.wa_message_id) return;
  whatsapp.sendTyping(ultimo.wa_message_id)
    .catch((e) => console.error(`[wa] No se pudo mostrar "escribiendo" a ${waId}:`, e.message));
}

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
        mostrarEscribiendo(waId);
        await esperarSilencio(waId);
        // Se renueva: la espera para juntar mensajes consume parte de los 25 s.
        mostrarEscribiendo(waId);
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

// Reinicio de pruebas (config.pruebas.reiniciar): el número arranca de cero.
async function reset(waId) {
  if (enCurso.has(waId)) await enCurso.get(waId).promise;
  const lead = repo.resetConversation(waId);
  console.log(`[pruebas] Conversación reiniciada: ${waId}`);
  try {
    await whatsapp.sendMessage(waId, MSG_REINICIO);
  } catch (e) {
    console.error(`[wa] Error enviando a ${waId}:`, e.message);
  }
  return lead;
}

function idle() {
  return Promise.all([...enCurso.values()].map((e) => e.promise));
}

const { extractTags, cleanTags, applyGuardarDatos, applyBuscarPropiedades, buildContext, toApiMessages } = core;

module.exports = { kick, recover, idle, reset, retryNotices, describeInbound, mediaIdOf, extractTags, cleanTags, applyGuardarDatos, applyBuscarPropiedades, buildContext, toApiMessages };
