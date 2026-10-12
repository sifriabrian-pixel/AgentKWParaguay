// Core del agente: toda la lógica de un turno, sin transporte.
//
// Nunca envía nada ni llama a WhatsApp: devuelve lo que habría que enviar
// (messages) y los efectos a ejecutar (actions). El adapter de WhatsApp
// (agent.js) los ejecuta; el de test (test-adapter.js) solo los registra.
//
//   ingest(input)                     guarda el origen y el mensaje (antes de responder)
//   processPending(conversationId)    responde lo pendiente de ese número
//   handleMessage(input)              = ingest + processPending (lo que usa el QA)
//   tick(conversationId, now)         seguimientos programados (todavía no hay)
//
// AgentInput  = { conversationId, from, text, now?, messageId?, type?,
//                 attachments?: [{ type, mediaId }],
//                 metadata?: { source, adId, referral?, profileName? } }
// AgentAction = { type: 'handoff' | 'forward_document', payload }
// AgentOutput = { messages, actions, state, meta }
//
// conversationId es el wa_id del lead. deps = { store, llm, resolveAd, onLlmError }.
const crypto = require('crypto');
const config = require('../config/kw-py');
const repo = require('./repo');
const claude = require('./claude');
const campanas = require('./campanas');
const catalogo = require('./catalogo');
const clock = require('./clock');
const { calificacion } = require('./calificacion');
const { pendiente } = require('../prompts/kw-py');

const MSG_VACIO = 'Disculpe, no logré entender su mensaje. ¿Me lo podría escribir de otra forma?';

// ─── Tags del LLM (solo informativos: NO derivan) ───────────────────────────
const TAG_RE = /\[(HANDOFF_[A-Z_]+|AGENDA_ENTREVISTA|FLUJO_[A-Z_]+|CONSENT_GRANTED)\]/g;

function extractTags(texto) {
  return [...new Set([...texto.matchAll(TAG_RE)].map((m) => m[1]))];
}

function cleanTags(texto) {
  return texto.replace(TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Tags con los que el LLM cierra un flujo y pide pasar el lead a una persona.
const esTagDeDerivacion = (tag) => tag.startsWith('HANDOFF_') || tag === 'AGENDA_ENTREVISTA';

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

function applyGuardarDatos(waId, input, store = repo) {
  const cambios = [];

  if (input.abrir_flujo_adicional && claude.FLUJOS.includes(input.abrir_flujo_adicional)) {
    const actual = store.getCurrentLead(waId);
    if (actual.flujo && actual.flujo !== input.abrir_flujo_adicional) {
      const nuevo = store.createLead(waId, {
        nombrePerfil: actual.nombre_perfil,
        flujo: input.abrir_flujo_adicional,
        datos: actual.datos.nombre ? { nombre: actual.datos.nombre } : {},
      });
      store.addEvent(nuevo.id, 'flow_opened', { desde_lead: actual.id, desde_flujo: actual.flujo });
      cambios.push(`nuevo registro para el flujo ${input.abrir_flujo_adicional}`);
    }
  }

  const lead = store.getCurrentLead(waId);
  const campos = {};

  if (input.flujo && claude.FLUJOS.includes(input.flujo) && input.flujo !== lead.flujo) {
    if (lead.derived_at) {
      cambios.push('el flujo no se cambió porque el lead ya fue derivado (use abrir_flujo_adicional)');
    } else {
      campos.flujo = input.flujo;
      campos.lead_type = config.flujos[input.flujo].lead_type;
      if (lead.flujo) store.addEvent(lead.id, 'flow_changed', { from: lead.flujo, to: input.flujo });
      cambios.push(`flujo = ${input.flujo}`);
    }
  }

  const nuevos = sanitizeDatos(input.datos);

  // Consulta por una propiedad puntual (típico de pauta): se valida contra el
  // catálogo y se completan tipo, zona y flujo con los datos reales de la ficha.
  if (nuevos.propiedad_id && nuevos.propiedad_id !== lead.datos.propiedad_id) {
    const prop = catalogo.get(nuevos.propiedad_id);
    if (!prop) {
      delete nuevos.propiedad_id;
      cambios.push('propiedad_id ignorado: no existe en el catálogo');
    } else {
      if (!lead.datos.tipo && !nuevos.tipo) nuevos.tipo = prop.tipo;
      if (!lead.datos.zona && !nuevos.zona) nuevos.zona = [prop.barrio, prop.ciudad].filter(Boolean).join(', ');
      const flujoProp = prop.operacion === 'alquiler' ? 'alquiler' : 'compra';
      if (!lead.flujo && !campos.flujo) {
        campos.flujo = flujoProp;
        campos.lead_type = config.flujos[flujoProp].lead_type;
      }
      store.addEvent(lead.id, 'propiedad_consultada', { propiedad_id: prop.id, url: prop.url, asesor_nombre: prop.asesor_nombre });
    }
  }

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
    campos.consent_at = clock.nowISO();
    store.addEvent(lead.id, 'consent_notice_sent');
  }

  store.updateLead(lead.id, campos);
  const final = store.getLead(lead.id);
  return `Guardado (${cambios.join('; ') || 'sin cambios'}). Ficha actual: flujo=${final.flujo || 'sin definir'}, datos=${JSON.stringify(final.datos)}`;
}

// ─── buscar_propiedades ──────────────────────────────────────────────────────

function applyBuscarPropiedades(waId, input, store = repo) {
  const filtros = {
    operacion: ['venta', 'alquiler'].includes(input.operacion) ? input.operacion : undefined,
    tipo: typeof input.tipo === 'string' ? input.tipo : undefined,
    zona: typeof input.zona === 'string' ? input.zona : undefined,
    dormitorios_min: Number.isInteger(input.dormitorios_min) ? input.dormitorios_min : undefined,
    presupuesto_max: typeof input.presupuesto_max === 'number' && input.presupuesto_max > 0 ? input.presupuesto_max : undefined,
    moneda: ['USD', 'PYG'].includes(input.moneda) ? input.moneda : undefined,
  };
  const res = catalogo.buscar(filtros);
  const lead = store.getCurrentLead(waId);
  store.addEvent(lead.id, 'propiedades_buscadas', { filtros, total: res.total, ids: res.propiedades.map((p) => p.id) });
  if (res.total === 0) {
    return `Sin resultados en el catálogo para ${JSON.stringify(filtros)}. No invente opciones: diga que un asesor va a buscar alternativas y siga con el flujo.${res.nota ? ` Nota: ${res.nota}` : ''}`;
  }
  return JSON.stringify(res);
}

// ─── Contexto del turno ──────────────────────────────────────────────────────

function fechaParaguay() {
  return clock.date().toLocaleString('es-PY', {
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
    const r = lead.referral || {};
    const textoAnuncio = [r.headline, r.body].filter(Boolean).join(' — ');
    if (lead.campaign_status === 'ok' && lead.campaign_flujo) {
      const zona = lead.campaign_zona ? `, zona/proyecto: ${lead.campaign_zona}` : '';
      lineas.push(`- Llegó desde un anuncio de Meta. La pauta define flujo: ${lead.campaign_flujo}${zona}. No pregunte qué necesita: confirme y arranque ese flujo.`);
    } else {
      lineas.push('- Llegó desde un anuncio de Meta. Detecte el flujo conversando.');
    }
    if (textoAnuncio) lineas.push(`- Texto del anuncio: "${textoAnuncio.slice(0, 300)}" (si habla de una propiedad puntual, trátelo como CONSULTA POR UNA PROPIEDAD PUNTUAL)`);
  } else {
    lineas.push('- Llegó de forma orgánica (no desde un anuncio).');
  }

  lineas.push(`- Aviso de protección de datos: ${lead.consent_at ? 'YA enviado, no lo repita' : 'todavía NO enviado: si en este mensaje pide un dato personal, inclúyalo antes de la pregunta'}`);
  if (lead.datos.propiedad_id) {
    const prop = catalogo.get(lead.datos.propiedad_id);
    if (prop) {
      lineas.push(`- Consulta por esta propiedad: ${prop.tipo} en ${[prop.barrio, prop.ciudad].filter(Boolean).join(', ')}, ${prop.moneda} ${prop.precio} (${prop.url}).`);
      if (prop.descripcion) lineas.push(`  Descripción completa de la ficha (use esto para responder dudas):\n  ${prop.descripcion.replace(/\n/g, '\n  ')}`);
    }
  }
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

// ─── Estado y acciones ───────────────────────────────────────────────────────

// Foto del lead para quien llama. qualified es informativo: no decide nada.
function buildState(lead, tags = []) {
  if (!lead) return { leadId: null, flujo: null, datos: {}, nombre: null, qualified: false, faltantes: [], derived: false, tags };
  const { qualified, faltantes } = calificacion(lead.flujo, lead.datos);
  return {
    leadId: lead.id,
    flujo: lead.flujo,
    datos: lead.datos,
    // Si el lead no dio su nombre, queda el del perfil de WhatsApp como respaldo.
    nombre: lead.datos.nombre || lead.nombre_perfil || null,
    qualified,
    faltantes,
    derived: Boolean(lead.derived_at),
    status: lead.status,
    source: lead.source,
    tags,
  };
}

// CV del postulante → responsable de reclutamiento. Devuelve las acciones de
// reenvío; si no hay número configurado deja el evento y no reenvía nada.
function documentActions(lead, pendientes, store) {
  if (lead.flujo !== 'reclutamiento') return [];
  const docs = pendientes.filter((m) => (m.type === 'document' || m.type === 'image') && m.media_id);
  const destino = config.reclutamiento.whatsapp;
  const acciones = [];
  for (const doc of docs) {
    if (pendiente(destino)) {
      store.addEvent(lead.id, 'document_not_forwarded', { motivo: 'reclutamiento sin número configurado', media_id: doc.media_id });
      continue;
    }
    const nombre = lead.datos.nombre ? ` — ${lead.datos.nombre}` : '';
    acciones.push({
      type: 'forward_document',
      payload: { leadId: lead.id, waId: lead.wa_id, to: destino, mediaType: doc.type, mediaId: doc.media_id, caption: `📎 Documentación de postulante${nombre} (${lead.wa_id})` },
    });
  }
  return acciones;
}

function handoffActions(lead, tags) {
  const state = buildState(lead);
  return tags.filter(esTagDeDerivacion).map((tag) => ({
    type: 'handoff',
    payload: { leadId: lead.id, waId: lead.wa_id, tag, flujo: state.flujo, nombre: state.nombre, qualified: state.qualified, faltantes: state.faltantes, datos: state.datos },
  }));
}

// ─── Entrada ─────────────────────────────────────────────────────────────────

function referralOf(metadata = {}) {
  if (metadata.referral) return metadata.referral;
  if (metadata.adId) return { source_id: metadata.adId, source_type: 'ad' };
  return null;
}

// Guarda el origen del lead y el mensaje como pendiente. Es sincrónico: el
// webhook lo llama ANTES de responder 200 y antes de cualquier llamada al LLM.
// Un input sin texto ni adjuntos solo registra el origen (reacciones, etc.).
// Devuelve { lead, nuevo }; nuevo = false si el mensaje ya estaba (duplicado).
function ingest(input, { store = repo } = {}) {
  return clock.run(input.now, () => {
    const waId = input.conversationId;
    const metadata = input.metadata || {};
    const lead = store.captureInbound(waId, metadata.profileName || null, referralOf(metadata));

    const adjunto = (input.attachments || [])[0] || null;
    if (input.text == null && !adjunto) return { lead, nuevo: false };

    const nuevo = store.insertInbound({
      waId,
      leadId: lead.id,
      waMessageId: input.messageId || `core.${crypto.randomUUID()}`,
      type: input.type || adjunto?.type || 'text',
      body: input.text,
      mediaId: adjunto?.mediaId || null,
    });
    return { lead, nuevo };
  });
}

// ─── Turno ───────────────────────────────────────────────────────────────────

// Responde los mensajes pendientes de un número en un solo turno. Deja la
// respuesta guardada en estado 'enviando' y la devuelve en messages: enviarla
// (y marcarla como enviada) es trabajo del adapter.
//
// Si Claude falla: sin onLlmError, lanza. Con onLlmError(error, { lead,
// pendientes }), el adapter decide: devuelve un texto para cerrar el turno
// con ese mensaje, o null para dejarlo pendiente (processPending devuelve null).
async function turno(waId, { store = repo, llm = claude, resolveAd, onLlmError } = {}) {
  const pendientes = store.pendingInbound(waId);
  let lead = store.getCurrentLead(waId);
  if (!pendientes.length) return { messages: [], actions: [], state: buildState(lead), meta: { leadId: lead?.id || null, outboundId: null } };

  lead = await campanas.resolveLeadCampaign(lead, { store, resolveAd });

  const historial = toApiMessages([...store.history(waId), ...pendientes.filter((m) => m.body)]);
  let texto;
  let tags = [];
  try {
    const res = await llm.chat(historial, buildContext(lead), {
      guardar_datos: (input) => applyGuardarDatos(waId, input, store),
      buscar_propiedades: (input) => applyBuscarPropiedades(waId, input, store),
    });
    tags = extractTags(res.texto);
    texto = cleanTags(res.texto);
    if (res.stopReason === 'refusal') store.addEvent(lead.id, 'llm_refusal');
    if (!texto) texto = MSG_VACIO;
  } catch (e) {
    if (!onLlmError) throw e;
    texto = await onLlmError(e, { lead, pendientes });
    if (texto == null) return null;
  }

  // El lead puede haber cambiado en el turno (abrir_flujo_adicional).
  lead = store.getCurrentLead(waId);
  const actions = documentActions(lead, pendientes, store);

  for (const tag of tags) store.addEvent(lead.id, 'llm_tag', { tag });
  actions.push(...handoffActions(lead, tags));

  const outboundId = store.commitTurn({ waId, leadId: lead.id, inboundIds: pendientes.map((m) => m.id), replyText: texto, tags });
  return { messages: [texto], actions, state: buildState(lead, tags), meta: { leadId: lead.id, outboundId } };
}

function processPending(conversationId, now, deps = {}) {
  return clock.run(now, () => turno(conversationId, deps));
}

function handleMessage(input, deps = {}) {
  return clock.run(input.now, () => {
    ingest(input, deps);
    return turno(input.conversationId, deps);
  });
}

// Seguimientos programados (2 h / 48 h). Todavía no están construidos: no
// devuelve mensajes ni acciones, solo el estado del lead a esa hora.
async function tick(conversationId, now, { store = repo } = {}) {
  return clock.run(now, () => {
    const lead = store.getCurrentLead(conversationId);
    return { messages: [], actions: [], state: buildState(lead), meta: { leadId: lead?.id || null, outboundId: null } };
  });
}

module.exports = {
  ingest, processPending, handleMessage, tick, buildState,
  extractTags, cleanTags, applyGuardarDatos, applyBuscarPropiedades, buildContext, toApiMessages,
};
