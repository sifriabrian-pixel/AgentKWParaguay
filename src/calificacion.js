// Calificación de un lead: compara los datos capturados contra los requeridos
// del flujo (config.flujos). Función pura; hoy solo informa (state.qualified),
// no cambia ninguna decisión del agente.
const config = require('../config/kw-py');

const tiene = (v) => v !== undefined && v !== null && v !== '' && v !== false;

// Devuelve { qualified, faltantes }. Sin flujo definido nunca está calificado.
function calificacion(flujo, datos = {}, flujos = config.flujos) {
  const def = flujos[flujo];
  if (!def) return { qualified: false, faltantes: [] };
  const faltantes = def.requeridos.filter((campo) => !tiene(datos[campo]));
  const excluido = (def.excluye || []).some((campo) => tiene(datos[campo]));
  return { qualified: faltantes.length === 0 && !excluido, faltantes };
}

module.exports = { calificacion };
