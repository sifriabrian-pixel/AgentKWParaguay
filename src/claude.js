// Llamada a Claude con tool calling: una sola llamada por turno (más las
// vueltas del ciclo de herramientas) que conversa y guarda datos a la vez.
const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt } = require('../prompts/kw-py');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.ANTHROPIC_EFFORT || 'low'; // chat: respuestas cortas, baja latencia
const MAX_VUELTAS = 4;

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}
// Para tests: inyectar un cliente falso con la misma forma (beta.messages.create).
function setClient(c) { client = c; }

const CAMPOS_DATOS = {
  nombre: { type: 'string' },
  tipo: { type: 'string', description: 'casa, departamento, terreno, local, otro' },
  zona: { type: 'string', description: 'ciudad, barrio o proyecto' },
  presupuesto: { type: 'number', description: 'solo el número, sin moneda ni separadores' },
  moneda: { type: 'string', enum: ['USD', 'PYG'] },
  dormitorios: { type: 'string' },
  formaPago: { type: 'string', enum: ['contado', 'financiado'] },
  fechaMudanza: { type: 'string' },
  operacion: { type: 'string', enum: ['venta'], description: 'solo flujo captacion (siempre venta)' },
  dia: { type: 'string', description: 'día para la visita de tasación' },
  franja: { type: 'string', enum: ['manana', 'tarde', 'cualquiera'] },
  ciudad: { type: 'string', description: 'solo flujo reclutamiento' },
  disponibilidad: { type: 'string' },
  experiencia: { type: 'string' },
  entrevistaConfirmada: { type: 'boolean' },
  descalificado: { type: 'boolean' },
  pide_humano: { type: 'boolean', description: 'true si pidió explícitamente hablar con una persona' },
  derivar_oficina: { type: 'boolean', description: 'true si la consulta no entra en ningún flujo y la tiene que atender la oficina (por ejemplo, un propietario que quiere alquilar su propiedad)' },
  observacion: { type: 'string', description: 'contexto útil para el asesor, una oración' },
};

const FLUJOS = ['compra', 'alquiler', 'captacion', 'reclutamiento'];

const TOOLS = [{
  name: 'guardar_datos',
  description: 'Guarda en la ficha del lead los datos que el cliente dio en la conversación y el flujo identificado. Llamala cada vez que aparezca un dato nuevo, antes de responder. Solo datos dichos por el cliente.',
  input_schema: {
    type: 'object',
    properties: {
      flujo: { type: 'string', enum: FLUJOS, description: 'Fija o corrige el flujo de la conversación actual' },
      abrir_flujo_adicional: { type: 'string', enum: FLUJOS, description: 'Abre un segundo registro cuando el cliente tiene otra necesidad además de la actual' },
      datos: { type: 'object', properties: CAMPOS_DATOS, additionalProperties: false },
      aviso_privacidad_enviado: { type: 'boolean' },
    },
    additionalProperties: false,
  },
}, {
  name: 'buscar_propiedades',
  description: 'Busca en el catálogo de Keller Williams Paraguay propiedades que coincidan con lo que pide el cliente. Usala solo cuando ya sabés la operación, el tipo y la zona. Devuelve hasta 3 opciones reales con su link; nunca muestres propiedades que no vengan de esta herramienta.',
  input_schema: {
    type: 'object',
    properties: {
      operacion: { type: 'string', enum: ['venta', 'alquiler'], description: 'venta si el cliente quiere comprar; alquiler si quiere alquilar' },
      tipo: { type: 'string', description: 'departamento, monoambiente, casa, terreno, oficina, local comercial' },
      zona: { type: 'string', description: 'barrio o ciudad, por ejemplo "Recoleta", "Las Lomas", "Lambaré"' },
      dormitorios_min: { type: 'integer' },
      presupuesto_max: { type: 'number' },
      moneda: { type: 'string', enum: ['USD', 'PYG'] },
    },
    required: ['operacion'],
    additionalProperties: false,
  },
}];

// contexto: texto del turno (datos capturados, origen). Va en un bloque de
// system aparte, sin cache, porque cambia en cada llamada.
// handlers: { guardar_datos(input), buscar_propiedades(input) } → string con el
// resultado que se le devuelve a Claude.
async function chat(historial, contexto, handlers) {
  const system = [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }];
  if (contexto) system.push({ type: 'text', text: contexto });

  const messages = [...historial];
  const textos = [];
  let stopReason = null;

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: EFFORT },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      tools: TOOLS,
      messages,
    });
    stopReason = response.stop_reason;
    if (stopReason === 'refusal') break;

    // Se queda con el texto de la última vuelta que escribió algo: si Claude
    // escribe, guarda datos y vuelve a escribir, la respuesta final es la última.
    const textoVuelta = response.content.filter((b) => b.type === 'text').map((b) => b.text.trim()).filter(Boolean);
    if (textoVuelta.length) textos.splice(0, textos.length, ...textoVuelta);

    if (stopReason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const usos = response.content.filter((b) => b.type === 'tool_use');
    if (stopReason !== 'tool_use' || usos.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const resultados = [];
    for (const uso of usos) {
      let contenido;
      let esError = false;
      const handler = handlers[uso.name];
      try {
        contenido = handler ? handler(uso.input || {}) : `Herramienta desconocida: ${uso.name}`;
        esError = !handler;
      } catch (e) {
        contenido = `Error en ${uso.name}: ${e.message}`;
        esError = true;
      }
      resultados.push({ type: 'tool_result', tool_use_id: uso.id, content: contenido, is_error: esError });
    }
    messages.push({ role: 'user', content: resultados });
  }

  return { texto: textos.join('\n\n'), stopReason };
}

module.exports = { chat, setClient, FLUJOS, CAMPOS_DATOS, MODEL };
