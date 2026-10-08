// Se carga con `node -r` para levantar el servidor real con un Claude falso
// (lento, para poder matar el proceso en medio de un turno).
const claude = require('../../src/claude');

const DEMORA_MS = Number(process.env.FAKE_CLAUDE_DELAY_MS || 1500);

claude.setClient({
  beta: {
    messages: {
      create: async (params) => {
        await new Promise((r) => setTimeout(r, DEMORA_MS));
        const last = params.messages[params.messages.length - 1];
        const vieneDeTool = Array.isArray(last.content) && last.content[0]?.type === 'tool_result';
        const texto = typeof last.content === 'string' ? last.content : '';
        if (!vieneDeTool && /alquilar/i.test(texto)) {
          return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'guardar_datos', input: { flujo: 'alquiler', datos: { nombre: 'Luis', zona: 'Asunción' } } }] };
        }
        if (!vieneDeTool && /departamento/i.test(texto)) {
          return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'guardar_datos', input: { datos: { tipo: 'departamento' } } }] };
        }
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: `Respuesta a: ${texto.split('\n').pop()}` }] };
      },
    },
  },
});
