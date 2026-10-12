// Calificación de un lead: compara los datos capturados contra los requeridos
// del flujo (config.flujos). Función pura. Un lead sin calificar no se deriva,
// salvo que pida hablar con una persona (ver derivar() en core.js).
const config = require('../config/kw-py');

const tiene = (v) => v !== undefined && v !== null && v !== '' && v !== false;

// Devuelve { qualified, faltantes }. Sin flujo definido nunca está calificado.
function calificacion(flujo, datos = {}, flujos = config.flujos) {
  const def = flujos[flujo];
  if (!def) return { qualified: false, faltantes: [] };
  // Consulta por una propiedad del catálogo: primero la ficha, después se califica con otros datos.
  const requeridos = tiene(datos.propiedad_id) && def.requeridosPuntual ? def.requeridosPuntual : def.requeridos;
  const faltantes = requeridos.filter((campo) => !tiene(datos[campo]));
  const excluido = (def.excluye || []).some((campo) => tiene(datos[campo]));
  return { qualified: faltantes.length === 0 && !excluido, faltantes };
}

module.exports = { calificacion };
