// Ruteo de leads: a quién se deriva cada lead y qué dice el aviso.
//
// Reglas del piloto (gana la primera que encuentre a alguien):
//   1. reclutamiento → responsable de reclutamiento
//   2. compra / alquiler / captacion → asesores de ese flujo, por turnos
//   3. fallback → oficina
// Los asesores tienen zonas y proyectos, y las fichas y campañas traen su
// asesor, pero esas reglas todavía no se aplican.
const config = require('../config/kw-py');
const catalogo = require('./catalogo');
const { pendiente } = require('../prompts/kw-py');

const digitos = (s) => String(s || '').replace(/\D/g, '');

function fijo(rol) {
  const p = config[rol];
  if (!p || pendiente(p.whatsapp)) return null;
  return { id: rol, nombre: pendiente(p.nombre) ? rol : p.nombre, whatsapp: digitos(p.whatsapp), rol };
}

function asesoresDe(flujo) {
  return (config.asesores || []).filter((a) => a.activa !== false && !pendiente(a.whatsapp) && (a.flujos || []).includes(flujo));
}

// Devuelve { persona, regla } o null si no hay nadie configurado.
// store.nextTurn(poolKey) lleva el turno de cada grupo (tabla asesor_rr).
function elegirDestino(lead, store) {
  if (lead.flujo === 'reclutamiento') {
    const responsable = fijo('reclutamiento');
    if (responsable) return { persona: responsable, regla: 'reclutamiento' };
  } else if (lead.flujo) {
    const grupo = asesoresDe(lead.flujo);
    if (grupo.length) {
      const a = grupo[store.nextTurn(lead.flujo) % grupo.length];
      return { persona: { id: a.id, nombre: a.nombre, whatsapp: digitos(a.whatsapp), rol: 'asesor' }, regla: 'flujo' };
    }
  }
  const oficina = fijo('oficina');
  return oficina ? { persona: oficina, regla: 'oficina' } : null;
}

// Números del equipo (asesores, oficina, reclutamiento): si escriben al
// agente no son leads.
function esNumeroInterno(waId) {
  const n = digitos(waId);
  const internos = [...(config.asesores || []), config.oficina, config.reclutamiento]
    .filter((p) => p && !pendiente(p.whatsapp))
    .map((p) => digitos(p.whatsapp));
  return internos.includes(n);
}

// ─── Aviso al asesor ─────────────────────────────────────────────────────────

const FLUJOS = {
  compra: 'Compra',
  alquiler: 'Alquiler',
  captacion: 'Quiere vender su propiedad',
  reclutamiento: 'Quiere ser asesor',
};

// Meta no acepta variables vacías ni con saltos de línea.
const unaLinea = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300) || '-';

function datosClave(d) {
  const partes = [
    d.tipo,
    d.zona,
    d.dormitorios && `${d.dormitorios} dorm.`,
    d.presupuesto && `hasta ${d.moneda || ''} ${Number(d.presupuesto).toLocaleString('es-PY')}`.replace(/\s+/g, ' '),
    d.formaPago,
    d.fechaMudanza && `mudanza: ${d.fechaMudanza}`,
    d.dia && `visita: ${[d.dia, d.franja].filter(Boolean).join(', ')}`,
    d.ciudad,
    d.disponibilidad && `disponibilidad: ${d.disponibilidad}`,
    d.experiencia && `experiencia: ${d.experiencia}`,
    d.diaContacto && `contactar: ${d.diaContacto}`,
  ];
  return unaLinea(partes.filter(Boolean).join(', '));
}

function resumen(d) {
  const prop = d.propiedad_id ? catalogo.get(d.propiedad_id) : null;
  const partes = [
    prop && `Consulta por ${prop.tipo} en ${[prop.barrio, prop.ciudad].filter(Boolean).join(', ')} (${prop.url})`,
    d.proposito && `Busca para ${d.proposito === 'inversion' ? 'inversión' : 'vivir'}`,
    d.observacion,
  ];
  return unaLinea(partes.filter(Boolean).join('. '));
}

// Arma el aviso desde los datos guardados, nunca desde texto libre del LLM.
// params = variables de la plantilla nuevo_lead_asesor; texto = el mismo aviso
// como mensaje común, por si la plantilla no está disponible.
function buildAviso(lead, motivo) {
  const params = {
    motivo,
    nombre: unaLinea(lead.datos.nombre || lead.nombre_perfil),
    telefono: `+${digitos(lead.wa_id)}`,
    flujo: FLUJOS[lead.flujo] || 'Consulta general',
    datos: datosClave(lead.datos),
    resumen: resumen(lead.datos),
  };
  const texto = [
    'Nuevo lead de WhatsApp para atender.',
    '',
    `Motivo: ${params.motivo}`,
    `Nombre: ${params.nombre}`,
    `Teléfono: ${params.telefono}`,
    `Consulta: ${params.flujo}`,
    `Datos: ${params.datos}`,
    `Resumen: ${params.resumen}`,
    '',
    'Favor contactar al lead a la brevedad por este medio.',
  ].join('\n');
  return { params, texto };
}

module.exports = { elegirDestino, esNumeroInterno, buildAviso };
