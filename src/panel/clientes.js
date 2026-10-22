// Ficha del cliente para el panel (el mismo formato que usa el panel Sifer v2
// para Diamond e Impacta). Este agente atiende a un solo cliente: KW Paraguay.
const config = require('../../config/kw-py');

function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Barrios de Asunción y ciudades del Gran Asunción, para agrupar la demanda.
const BARRIOS_ASUNCION = [
  'asuncion', 'recoleta', 'villa morra', 'las lomas', 'carmelitas', 'manora', 'ytay', 'jara', 'mburucuya',
  'los laureles', 'mariscal lopez', 'mcal. lopez', 'mariscal estigarribia', 'herrera', 'sajonia', 'centro',
  'san cristobal', 'santo domingo', 'ycua sati', 'trinidad', 'santisima trinidad', 'bella vista', 'mburicao',
  'villa aurelia', 'tembetary', 'nazareth', 'san vicente', 'pinoza', 'tablada', 'loma pyta', 'botanico',
];
const GRAN_ASUNCION = [
  'lambare', 'luque', 'san lorenzo', 'fernando de la mora', 'mariano roque alonso', 'capiata', 'limpio',
  'nemby', 'villa elisa', 'san antonio', 'aregua', 'itaugua', 'ypane', 'guarambare', 'j. augusto saldivar',
];

function zonaKw(datos) {
  const ref = normalizar([datos?.zona, datos?.ciudad].filter(Boolean).join(' '));
  if (!ref) return 'Sin especificar';
  if (GRAN_ASUNCION.some((c) => ref.includes(c))) return 'Gran Asunción';
  if (BARRIOS_ASUNCION.some((b) => ref.includes(b))) return 'Asunción';
  return 'Interior / otra';
}

const pendiente = (v) => !v || String(v).startsWith('[PENDIENTE');

const CLIENTES = {
  kw: {
    id: 'kw',
    nombre: config.cliente,
    ubicacion: 'Asunción',
    agente: pendiente(config.agente.nombre) ? 'Asistente KW' : config.agente.nombre,
    timezone: config.zonaHoraria,
    // Horario de la oficina, para "Fuera de horario" en Valor del agente.
    horario: config.horarioOficina,
    zonas: ['Asunción', 'Gran Asunción', 'Interior / otra', 'Sin especificar'],
    clasificarZona: zonaKw,
  },
};

module.exports = { CLIENTES, normalizar };
