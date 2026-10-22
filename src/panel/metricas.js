// Copia de sifer-panel-v2/src/metricas.js (KW: la calificación la arma panel/datos.js con el criterio del agente).
// Todas las métricas del panel. Cada una está definida en docs/METRICS.md y
// docs/SPEC-panel-sifer-v2.md; si cambiás una fórmula acá, actualizá esos documentos.
//
// TODO: Reactivar métricas de contacto (Contactados, tiempo a contacto, sin
// contacto >24h, vencidos) cuando se implemente el loop de confirmación por
// WhatsApp. Los datos siguen guardándose (marca "Asesor contactó" →
// marked_attended); solo se sacaron de las vistas porque la marca manual no
// es una fuente confiable.

const { OPERACIONES, esPersona } = require('./datos');
const { HORA_MS, DIA_MS, diaLocal, diasEntre, fueraDeHorario } = require('./tiempo');

// Un calificado que no se derivó en este tiempo es una falla del agente
// (Salud del agente + alerta por email a los admins de Sifer).
const WATCHDOG_MIN = 15;
// Ventana de la cola (evita que leads viejos tapen lo que hay que hacer hoy).
const VENTANA_ENFRIADOS_DIAS = 14;

const t = (f) => (f ? new Date(f).getTime() : NaN);
const enRango = (f, from, to) => { const x = t(f); return x >= from && x < to; };
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

function mediana(valores) {
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ── Calificado (única fuente de verdad) ──────────────────────────────────
//
// Hay dos tipos de calificado:
//
// CLIENTE (compra, alquiler, venta o arriendo de una propiedad):
//   a) operación + zona/ciudad + presupuesto o tipo de propiedad, o
//   b) pidió explícitamente hablar con un asesor, visitar o que lo llamen.
//   El nombre NO es requisito. Fuera de cobertura no califica.
//
// ASESOR (postulante, flujo "asesor"): pasó los 3 filtros del agente de
// reclutamiento: vive en la zona, tiene disponibilidad presencial y puede
// incorporarse. Es decir: no está descalificado y tiene ciudad, disponibilidad
// y situación; o el agente ya le agendó la entrevista (solo la ofrece si pasó
// los filtros).

const OPERACIONES_CALIFICABLES = new Set(['Compra', 'Alquiler', 'Vender su propiedad', 'Arrendar su propiedad', 'Propiedad pautada']);
const PIDE_CONTACTO = /hablar con (un |una |el |la )?asesor|quiero (una )?visita|visitar|ver la propiedad|conocer la propiedad|ll[aá]m(e|en|ar)(me|nos)|me (pueden|puede|podr[ií]an) llamar|una llamada/i;

const tieneTexto = (v) => v != null && String(v).trim() !== '';
const esVerdadero = (v) => v === true || String(v).toLowerCase() === 'true';

function evaluarPostulante(l) {
  const d = l.datos;
  if (esVerdadero(d.descalificado)) return { calificado: false };
  const entrevista = l.eventos.find((e) => e.tipo === 'agenda_entrevista' || e.tipo === 'handoff_asesor');
  if (entrevista || tieneTexto(d.entrevistaFecha) || esVerdadero(d.entrevistaConfirmada)) {
    return { calificado: true, tipo: 'asesor', motivo: 'Pasó los filtros y se le agendó entrevista', desde: entrevista?.fecha || l.ultimoMensaje };
  }
  if (tieneTexto(d.ciudad) && tieneTexto(d.disponibilidad) && tieneTexto(d.situacion)) {
    const ultimoDelLead = [...l.historial].reverse().find((m) => m.role === 'user');
    return { calificado: true, tipo: 'asesor', motivo: 'Pasó los filtros de ubicación, disponibilidad e incorporación', desde: ultimoDelLead?.ts || l.ultimoMensaje };
  }
  return { calificado: false };
}

function evaluarCalificacion(l) {
  if (l.flujo === 'asesor') return evaluarPostulante(l);
  if (l.fueraCobertura) return { calificado: false };

  const pedido = l.historial.find((m) => m.role === 'user' && PIDE_CONTACTO.test(m.content || ''));
  if (l.flujo === 'hablar_asesor' || pedido) {
    return { calificado: true, tipo: 'cliente', motivo: 'Pidió hablar con un asesor, visitar o que lo llamen', desde: pedido?.ts || l.ultimoMensaje };
  }

  const d = l.datos;
  // Una propiedad pautada ya trae operación, zona y tipo de propiedad.
  const pautada = l.operacion === 'Propiedad pautada' || tieneTexto(d.propiedadPautada) || tieneTexto(d.codigoPropiedad);
  const operacion = OPERACIONES_CALIFICABLES.has(l.operacion);
  const zona = pautada || tieneTexto(d.zona) || tieneTexto(d.sector) || tieneTexto(d.ciudad);
  const presupuestoOTipo = pautada || tieneTexto(d.presupuesto) || tieneTexto(d.precio) || tieneTexto(d.tipo);
  if (operacion && zona && presupuestoOTipo) {
    // No se sabe en qué mensaje se completó el último dato: se usa el último
    // mensaje del lead como momento de calificación (criterio conservador).
    const ultimoDelLead = [...l.historial].reverse().find((m) => m.role === 'user');
    return { calificado: true, tipo: 'cliente', motivo: 'Operación, zona y presupuesto o tipo de propiedad', desde: ultimoDelLead?.ts || l.ultimoMensaje };
  }
  return { calificado: false };
}

// Salud del agente (métrica interna de Sifer, solo admin): calificado sin
// evento de derivación más de 15 min después de calificar. No importa si la
// revisora lo gestionó a mano: mide si el AGENTE derivó.
function calificadoSinDerivar(l, ahora = Date.now()) {
  if (!l.calificado || l.derivado) return false;
  return ahora - t(l.calificadoEn) > WATCHDOG_MIN * 60000;
}

function motivoSinDerivar(l) {
  return l.eventos.some((e) => e.tipo === 'derivation_failed') ? 'Falló la derivación' : 'Sin evento de derivación';
}

// Mismo período y misma cohorte que las KPIs: el número cierra con el embudo.
function saludAgente(modelo, periodo, ahora = Date.now()) {
  const cohorte = modelo.leads.filter((l) => enRango(l.creadoEn, periodo.from, periodo.to));
  const calificados = cohorte.filter((l) => l.calificado);
  const calificadosDerivados = calificados.filter((l) => l.derivado);
  const pendientes = calificados
    .filter((l) => calificadoSinDerivar(l, ahora))
    .sort((a, b) => t(a.calificadoEn) - t(b.calificadoEn))
    .map((l) => ({ lead: l, motivo: motivoSinDerivar(l), esperaMs: ahora - t(l.calificadoEn) }));

  const tope = calificados.length - calificadosDerivados.length;
  const consistente = pendientes.length <= tope;
  if (!consistente) {
    console.error(`[salud] ${modelo.cliente.id}: calificados sin derivar (${pendientes.length}) > calificados − derivados (${tope})`);
  }
  // Calificados hace menos de 15 min: todavía están dentro del margen.
  const enMargen = tope - pendientes.length;
  // Derivaciones cargadas por backfill (retroactive: true): cuentan en el
  // período en que entró el lead y acá se listan marcadas.
  const retroactivas = cohorte.filter((l) => l.derivado && l.derivacionRetroactiva);
  return {
    atendidos: cohorte.length,
    clasificados: cohorte.filter((l) => l.flujo).length,
    calificados: calificados.length,
    calificadosDerivados: calificadosDerivados.length,
    derivados: cohorte.filter((l) => l.derivado).length,
    pendientes, enMargen, consistente, retroactivas,
  };
}

// ── Etapa de un lead ─────────────────────────────────────────────────────

function etapa(l) {
  if (l.prioridad === 'descartado') return 'descartado';
  if (l.derivado) return 'derivado';
  if (l.fueraCobertura) return 'fuera';
  if (l.calificado) return 'calificado';
  return 'nuevo';
}

const ETAPAS = {
  nuevo: 'Conversando',
  calificado: 'Calificado',
  derivado: 'Derivado',
  fuera: 'Fuera de cobertura',
  descartado: 'Descartado',
};

// Segundos entre el primer mensaje del lead y la primera respuesta del agente.
// Solo es confiable si el historial no fue recortado (tope de 40 mensajes).
function respuestaAgente(l) {
  if (!l.historialCompleto) return null;
  const i = l.historial.findIndex((m) => m.role === 'user');
  if (i < 0) return null;
  const resp = l.historial.slice(i + 1).find((m) => m.role === 'assistant' && m.ts);
  return resp ? (t(resp.ts) - t(l.historial[i].ts)) / 1000 : null;
}

// ── Resumen ──────────────────────────────────────────────────────────────

function kpisDe(cohorte, modelo, from, to) {
  const clasificados = cohorte.filter((l) => l.flujo);
  const calificados = cohorte.filter((l) => l.calificado);
  const derivados = cohorte.filter((l) => l.derivado);
  const calificadosDerivados = calificados.filter((l) => l.derivado);
  const eventosEn = (tipo) => new Set(
    modelo.eventos.filter((e) => e.tipo === tipo && enRango(e.fecha, from, to)).map((e) => e.numero),
  ).size;
  // Dos circuitos: clientes (propiedades) y postulantes a asesor (reclutamiento).
  const esPostulante = (l) => l.flujo === 'asesor';
  const clientes = cohorte.filter((l) => !esPostulante(l));
  const postulantes = cohorte.filter(esPostulante);
  const circuito = (lista) => {
    const cal = lista.filter((l) => l.calificado);
    return {
      leads: lista.length,
      calificados: cal.length,
      calificadosDerivados: cal.filter((l) => l.derivado).length,
      derivados: lista.filter((l) => l.derivado).length,
    };
  };
  return {
    atendidos: cohorte.length,
    clasificados: clasificados.length,
    calificados: calificados.length,
    derivados: derivados.length,
    calificadosDerivados: calificadosDerivados.length,
    clientes: circuito(clientes),
    postulantes: circuito(postulantes),
    tasaClasificacion: pct(clasificados.length, cohorte.length),
    tasaCalificacion: pct(calificados.length, cohorte.length),
    tasaDerivacion: pct(derivados.length, cohorte.length),
    fueraHorario: cohorte.filter((l) => l.creadoEn && fueraDeHorario(l.creadoEn, modelo.cliente)).length,
    respuestaAgenteSeg: mediana(cohorte.map(respuestaAgente)),
    reactivados: eventosEn('reactivado'),
    conSeguimiento: new Set(modelo.eventos
      .filter((e) => e.tipo.startsWith('seguimiento_') && enRango(e.fecha, from, to))
      .map((e) => e.numero)).size,
    desdeAnuncio: cohorte.filter((l) => l.origen).length,
  };
}

function tasaLectura(leads, from, to) {
  let leidos = 0, llegaron = 0;
  for (const l of leads) {
    for (const m of l.historial) {
      if (m.role !== 'assistant' || !m.estadoEnvio || !enRango(m.ts, from, to)) continue;
      if (m.estadoEnvio === 'entregado' || m.estadoEnvio === 'leido') {
        llegaron++;
        if (m.estadoEnvio === 'leido') leidos++;
      }
    }
  }
  return pct(leidos, llegaron);
}

function resumen(modelo, periodo, ahora = Date.now()) {
  const { leads, cliente } = modelo;
  const tz = cliente.timezone;
  const cohorte = leads.filter((l) => enRango(l.creadoEn, periodo.from, periodo.to));
  const cohortePrev = leads.filter((l) => enRango(l.creadoEn, periodo.prevFrom, periodo.prevTo));

  const actual = kpisDe(cohorte, modelo, periodo.from, periodo.to);
  const anterior = kpisDe(cohortePrev, modelo, periodo.prevFrom, periodo.prevTo);
  actual.tasaLectura = tasaLectura(leads, periodo.from, periodo.to);
  anterior.tasaLectura = tasaLectura(leads, periodo.prevFrom, periodo.prevTo);

  // Serie diaria por día de entrada: derivados ⊂ atendidos, se pueden superponer.
  const dias = diasEntre(periodo.from, periodo.to, tz);
  const porDia = Object.fromEntries(dias.map((d) => [d, { dia: d, atendidos: 0, derivados: 0 }]));
  for (const l of cohorte) {
    const d = porDia[diaLocal(l.creadoEn, tz)];
    if (!d) continue;
    d.atendidos++;
    if (l.derivado) d.derivados++;
  }

  return {
    actual,
    anterior,
    serie: dias.map((d) => porDia[d]),
    cohorte,
  };
}

// ── Cola "Requieren atención" ────────────────────────────────────────────

function colaAtencion(modelo, ahora = Date.now()) {
  const items = [];
  const vistos = new Set();
  const agregar = (l, prioridad, motivo, desde) => {
    if (vistos.has(l.numero)) return;
    vistos.add(l.numero);
    items.push({ lead: l, prioridad, motivo, esperaMs: desde ? ahora - t(desde) : null });
  };

  // 1. Marcados urgentes (a mano o por el agente)
  const urgentes = modelo.leads.filter((l) => l.prioridad === 'urgente');
  for (const l of urgentes.sort((a, b) => t(a.ultimoMensaje) - t(b.ultimoMensaje))) {
    const marca = [...l.eventos].reverse().find((e) => e.tipo === 'marked_urgent');
    agregar(l, 1, l.prioridadManual ? 'Marcado urgente' : 'Urgente según el agente', marca?.fecha || l.ultimoMensaje);
  }

  // "Calificado sin derivar" no va acá: es una métrica interna de Sifer
  // (Salud del agente, solo admin).

  // 2. Clasificados (no calificados) que llevan más de 24 h en silencio
  const enfriados = modelo.leads.filter((l) => {
    // Si la revisora ya lo marcó o le dejó una nota (ej. "Revisado Grace"), ya lo vio.
    if (!l.flujo || l.calificado || l.derivado || l.fueraCobertura || l.prioridad || l.nota) return false;
    const silencio = ahora - t(l.ultimoMensaje);
    return silencio > 24 * HORA_MS && silencio < VENTANA_ENFRIADOS_DIAS * DIA_MS;
  });
  for (const l of enfriados.sort((a, b) => t(a.ultimoMensaje) - t(b.ultimoMensaje))) {
    agregar(l, 2, 'Se enfrió sin calificar', l.ultimoMensaje);
  }

  return items;
}

// ── Asesores ─────────────────────────────────────────────────────────────

// Derivar a la oficina es una derivación válida: se muestra como "Oficina".
const SIN_ASESOR = 'Sin asesor asignado';
const OFICINA = 'Oficina';
const ES_OFICINA = /backup|oficina|recepci/i;

// Derivado, pero el agente no guardó a quién ni se pudo recuperar del aviso.
const DESTINO_NO_REGISTRADO = 'Destino no registrado';

function nombreAsesor(l) {
  if (esPersona(l.asesor)) return String(l.asesor).trim();
  if (ES_OFICINA.test(String(l.asesor || ''))) return OFICINA;
  return l.derivado ? DESTINO_NO_REGISTRADO : SIN_ASESOR;
}

function asesores(modelo, periodo) {
  const filas = new Map();
  let total = 0;
  for (const l of modelo.leads) {
    if (!l.derivado || !enRango(l.creadoEn, periodo.from, periodo.to)) continue;
    const nombre = nombreAsesor(l);
    filas.set(nombre, (filas.get(nombre) || 0) + 1);
    total++;
  }
  return [...filas.entries()]
    .map(([nombre, derivados]) => ({ nombre, derivados, porcentaje: pct(derivados, total) }))
    .sort((a, b) => b.derivados - a.derivados || a.nombre.localeCompare(b.nombre, 'es'));
}

// ── Demanda ──────────────────────────────────────────────────────────────

function tipologia(datos) {
  const s = String(datos.tipo || datos.tipoPropiedad || '').toLowerCase();
  if (!s) return 'Sin especificar';
  if (/depa|dpto|departamento|suite/.test(s)) return 'Departamento';
  if (/casa|villa/.test(s)) return 'Casa';
  if (/terreno|lote|solar/.test(s)) return 'Terreno';
  if (/local|oficina|bodega|galp/.test(s)) return 'Comercial';
  return 'Otro';
}

function contar(lista, claveFn, orden) {
  const conteo = new Map((orden || []).map((k) => [k, 0]));
  for (const x of lista) {
    const k = claveFn(x);
    if (k == null) continue;
    conteo.set(k, (conteo.get(k) || 0) + 1);
  }
  const filas = [...conteo.entries()].map(([nombre, cantidad]) => ({ nombre, cantidad }));
  return orden ? filas : filas.sort((a, b) => b.cantidad - a.cantidad);
}

function demanda(modelo, cohorte) {
  const buscan = cohorte.filter((l) => ['Compra', 'Alquiler', 'Consulta por una propiedad'].includes(l.operacion)); // KW

  const anuncios = new Map();
  for (const l of cohorte) {
    if (!l.origen) continue;
    const clave = l.origen.titulo || l.origen.url || 'Anuncio sin título';
    if (!anuncios.has(clave)) anuncios.set(clave, { nombre: clave, url: l.origen.url, cantidad: 0, derivados: 0 });
    const a = anuncios.get(clave);
    a.cantidad++;
    if (l.derivado) a.derivados++;
  }

  return {
    operacion: contar(cohorte, (l) => l.operacion, OPERACIONES).filter((f) => f.cantidad > 0 || f.nombre === 'Sin clasificar'),
    zona: contar(cohorte, (l) => l.zona, modelo.cliente.zonas),
    tipologia: contar(buscan, (l) => tipologia(l.datos), ['Departamento', 'Casa', 'Terreno', 'Comercial', 'Otro', 'Sin especificar']),
    anuncios: [...anuncios.values()].sort((a, b) => b.derivados - a.derivados || b.cantidad - a.cantidad).slice(0, 8),
  };
}

module.exports = {
  evaluarCalificacion, calificadoSinDerivar, saludAgente, resumen, colaAtencion, asesores, demanda, etapa, ETAPAS,
  nombreAsesor, SIN_ASESOR, OFICINA, DESTINO_NO_REGISTRADO, WATCHDOG_MIN,
};
