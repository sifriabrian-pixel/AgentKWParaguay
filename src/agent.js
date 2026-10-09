// Procesamiento de conversaciones.
//
// Flujo de un mensaje entrante:
//   webhook → repo.captureInbound (referral, ANTES de todo) → repo.insertInbound
//   (wa_message_id UNIQUE = filtro de duplicados) → agent.kick(waId)
//
// kick() procesa los mensajes pendientes de un número de a uno por vez (bloqueo
// por número). Si llegan varios seguidos se responden juntos en un solo turno.
// El estado vive en la base: si el proceso se reinicia, recover() retoma los
// mensajes que quedaron pendientes.
const config = require('../config/kw-py');
const repo = require('./repo');
const whatsapp = require('./whatsapp');
const claude = require('./claude');
const campanas = require('./campanas');
const catalogo = require('./catalogo');
const { pendiente } = require('../prompts/kw-py');

const MAX_INTENTOS = 3;
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 20000);
const MSG_ERROR = 'Disculpe, tuvimos un inconveniente técnico. ¿Me podría escribir de nuevo en unos minutos?';
const MSG_VACIO = 'Disculpe, no logré entender su mensaje. ¿Me lo podría escribir de otra forma?';

// ─── Tags del LLM (solo informativos: NO derivan) ───────────────────────────
const TAG_RE = /\[(HANDOFF_[A-Z_]+|AGENDA_ENTREVISTA|FLUJO_[A-Z_]+|CONSENT_GRANTED)\]/g;

function extractTags(texto) {
  return [...new Set([...texto.matchAll(TAG_RE)].map((m) => m[1]))];
}

function cleanTags(texto) {
  return texto.replace(TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

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

// ─── guardar_datos ───────────────────────────────────────────────────────────

// Valida el input de la herramienta contra el esquema (tipos y enums).
function sanitizeDatos(datos) {
  const limpio = {};
  if (!datos || typeof datos !== 'object') return limpio;
  for (const [campo, def] of Object.entries(claude.CAMPOS_DATOS)) {
    const v = datos[campo];
    if (v === undefined || v === null || v === '') continue;
    if (def.type === 'number') {
      // Formato paraguayo: punto para miles y coma para decimales ("120.000", "1.500,50").
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d,]/g, '').replace(',', '.'));
      if (Number.isFinite(n) && n > 0) limpio[campo] = n;
    } else if (def.type === 'boolean') {
      if (typeof v === 'boolean') limpio[campo] = v;
    } else if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      if (!s) continue;
      if (def.enum && !def.enum.includes(s)) continue;
      limpio[campo] = s;
    }
  }
  return limpio;
}

function applyGuardarDatos(waId, input) {
  const cambios = [];

  if (input.abrir_flujo_adicional && claude.FLUJOS.includes(input.abrir_flujo_adicional)) {
    const actual = repo.getCurrentLead(waId);
    if (actual.flujo && actual.flujo !== input.abrir_flujo_adicional) {
      const nuevo = repo.createLead(waId, {
        nombrePerfil: actual.nombre_perfil,
        flujo: input.abrir_flujo_adicional,
        datos: actual.datos.nombre ? { nombre: actual.datos.nombre } : {},
      });
      repo.addEvent(nuevo.id, 'flow_opened', { desde_lead: actual.id, desde_flujo: actual.flujo });
      cambios.push(`nuevo registro para el flujo ${input.abrir_flujo_adicional}`);
    }
  }

  const lead = repo.getCurrentLead(waId);
  const campos = {};

  if (input.flujo && claude.FLUJOS.includes(input.flujo) && input.flujo !== lead.flujo) {
    if (lead.derived_at) {
      cambios.push('el flujo no se cambió porque el lead ya fue derivado (use abrir_flujo_adicional)');
    } else {
      campos.flujo = input.flujo;
      campos.lead_type = config.flujos[input.flujo].lead_type;
      if (lead.flujo) repo.addEvent(lead.id, 'flow_changed', { from: lead.flujo, to: input.flujo });
      cambios.push(`flujo = ${input.flujo}`);
    }
  }

  const nuevos = sanitizeDatos(input.datos);
  if (Object.keys(nuevos).length) {
    campos.datos = { ...lead.datos, ...nuevos };
    cambios.push(`datos: ${Object.keys(nuevos).join(', ')}`);
  }

  // Captación es solo venta: la operación queda fija sin depender del LLM.
  const flujoFinal = campos.flujo || lead.flujo;
  const datosFinal = campos.datos || lead.datos;
  if (flujoFinal === 'captacion' && datosFinal.operacion !== 'venta') {
    campos.datos = { ...datosFinal, operacion: 'venta' };
  }

  if (input.aviso_privacidad_enviado === true && !lead.consent_at) {
    campos.consent_at = new Date().toISOString();
    repo.addEvent(lead.id, 'consent_notice_sent');
  }

  repo.updateLead(lead.id, campos);
  const final = repo.getLead(lead.id);
  return `Guardado (${cambios.join('; ') || 'sin cambios'}). Ficha actual: flujo=${final.flujo || 'sin definir'}, datos=${JSON.stringify(final.datos)}`;
}

// ─── buscar_propiedades ──────────────────────────────────────────────────────

function applyBuscarPropiedades(waId, input) {
  const filtros = {
    operacion: ['venta', 'alquiler'].includes(input.operacion) ? input.operacion : undefined,
    tipo: typeof input.tipo === 'string' ? input.tipo : undefined,
    zona: typeof input.zona === 'string' ? input.zona : undefined,
    dormitorios_min: Number.isInteger(input.dormitorios_min) ? input.dormitorios_min : undefined,
    presupuesto_max: typeof input.presupuesto_max === 'number' && input.presupuesto_max > 0 ? input.presupuesto_max : undefined,
    moneda: ['USD', 'PYG'].includes(input.moneda) ? input.moneda : undefined,
  };
  const res = catalogo.buscar(filtros);
  const lead = repo.getCurrentLead(waId);
  repo.addEvent(lead.id, 'propiedades_buscadas', { filtros, total: res.total, ids: res.propiedades.map((p) => p.id) });
  if (res.total === 0) {
    return `Sin resultados en el catálogo para ${JSON.stringify(filtros)}. No invente opciones: diga que un asesor va a buscar alternativas y siga con el flujo.${res.nota ? ` Nota: ${res.nota}` : ''}`;
  }
  return JSON.stringify(res);
}

// ─── Contexto del turno ──────────────────────────────────────────────────────

function fechaParaguay() {
  return new Date().toLocaleString('es-PY', {
    timeZone: config.zonaHoraria, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

function buildContext(lead) {
  const lineas = [
    'CONTEXTO DE ESTA CONVERSACIÓN (información del sistema; no la cite textual):',
    `- Fecha y hora en Paraguay: ${fechaParaguay()}`,
  ];
  if (lead.nombre_perfil) lineas.push(`- Nombre del perfil de WhatsApp: ${lead.nombre_perfil} (puede no ser el nombre real; pida el nombre igual)`);
  lineas.push(`- Flujo actual: ${lead.flujo || 'sin definir'}`);

  if (lead.source === 'ctwa') {
    if (lead.campaign_status === 'ok' && lead.campaign_flujo) {
      const zona = lead.campaign_zona ? `, zona/proyecto: ${lead.campaign_zona}` : '';
      lineas.push(`- Llegó desde un anuncio de Meta. La pauta define flujo: ${lead.campaign_flujo}${zona}. No pregunte qué necesita: confirme y arranque ese flujo.`);
    } else {
      const r = lead.referral || {};
      const texto = [r.headline, r.body].filter(Boolean).join(' — ');
      lineas.push(`- Llegó desde un anuncio de Meta${texto ? ` ("${texto.slice(0, 200)}")` : ''}. Detecte el flujo conversando.`);
    }
  } else {
    lineas.push('- Llegó de forma orgánica (no desde un anuncio).');
  }

  lineas.push(`- Aviso de protección de datos: ${lead.consent_at ? 'YA enviado, no lo repita' : 'todavía NO enviado: si en este mensaje pide un dato personal, inclúyalo antes de la pregunta'}`);
  lineas.push(`- Datos ya capturados (no los vuelva a preguntar): ${JSON.stringify(lead.datos)}`);
  if (lead.derived_at) lineas.push('- Este lead YA fue derivado a un asesor.');
  return lineas.join('\n');
}

// Convierte el historial de la base al formato de la API: alterna roles,
// une mensajes seguidos del mismo rol y arranca siempre con el usuario.
function toApiMessages(rows) {
  const out = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${r.body}`;
    else out.push({ role, content: r.body });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ─── CV del postulante → responsable de reclutamiento ────────────────────────

async function forwardDocuments(lead, pendientes) {
  if (lead.flujo !== 'reclutamiento') return;
  const docs = pendientes.filter((m) => (m.type === 'document' || m.type === 'image') && m.media_id);
  if (!docs.length) return;
  const destino = config.reclutamiento.whatsapp;
  for (const doc of docs) {
    if (pendiente(destino)) {
      repo.addEvent(lead.id, 'document_not_forwarded', { motivo: 'reclutamiento sin número configurado', media_id: doc.media_id });
      continue;
    }
    try {
      const nombre = lead.datos.nombre ? ` — ${lead.datos.nombre}` : '';
      await whatsapp.sendMedia(destino, doc.type, doc.media_id, `📎 Documentación de postulante${nombre} (${lead.wa_id})`);
      repo.addEvent(lead.id, 'document_forwarded', { media_id: doc.media_id, to: destino });
    } catch (e) {
      console.error(`[cv] Error reenviando documento de ${lead.wa_id}:`, e.message);
      repo.addEvent(lead.id, 'document_forward_failed', { media_id: doc.media_id, error: e.message });
    }
  }
}

// ─── Turno ───────────────────────────────────────────────────────────────────

// Devuelve true si el turno quedó cerrado; false si hay que reintentar más tarde.
async function processTurn(waId, pendientes) {
  let lead = repo.getCurrentLead(waId);
  lead = await campanas.resolveLeadCampaign(lead);

  const historial = toApiMessages([...repo.history(waId), ...pendientes.filter((m) => m.body)]);
  let texto;
  let tags = [];
  try {
    const res = await claude.chat(historial, buildContext(lead), {
      guardar_datos: (input) => applyGuardarDatos(waId, input),
      buscar_propiedades: (input) => applyBuscarPropiedades(waId, input),
    });
    tags = extractTags(res.texto);
    texto = cleanTags(res.texto);
    if (res.stopReason === 'refusal') repo.addEvent(lead.id, 'llm_refusal');
    if (!texto) texto = MSG_VACIO;
  } catch (e) {
    console.error(`[agent] Error de Claude para ${waId}:`, e.message);
    repo.bumpAttempts(pendientes.map((m) => m.id));
    const intentos = Math.max(...pendientes.map((m) => m.attempts)) + 1;
    repo.addEvent(lead.id, 'llm_error', { error: e.message, intento: intentos });
    if (intentos < MAX_INTENTOS) {
      setTimeout(() => kick(waId), RETRY_BASE_MS * intentos).unref();
      return false;
    }
    texto = MSG_ERROR;
  }

  // El lead puede haber cambiado en el turno (abrir_flujo_adicional).
  lead = repo.getCurrentLead(waId);
  await forwardDocuments(lead, pendientes);

  for (const tag of tags) repo.addEvent(lead.id, 'llm_tag', { tag });

  const outId = repo.commitTurn({ waId, leadId: lead.id, inboundIds: pendientes.map((m) => m.id), replyText: texto, tags });
  try {
    const res = await whatsapp.sendMessage(waId, texto);
    repo.markOutbound(outId, 'enviado', res?.messages?.[0]?.id || null);
    repo.updateLead(lead.id, { last_outbound_at: new Date().toISOString() });
  } catch (e) {
    console.error(`[wa] Error enviando a ${waId}:`, e.message);
    repo.markOutbound(outId, 'fallido');
    repo.addEvent(lead.id, 'send_failed', { error: e.message });
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
        const pendientes = repo.pendingInbound(waId);
        if (!pendientes.length) break;
        const cerrado = await processTurn(waId, pendientes);
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

module.exports = { kick, recover, idle, describeInbound, mediaIdOf, extractTags, cleanTags, applyGuardarDatos, applyBuscarPropiedades, buildContext, toApiMessages };
