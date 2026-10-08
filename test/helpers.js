// Utilidades de test: base temporal, Claude falso y WhatsApp capturado.
process.env.WHATSAPP_DRY_RUN = '1';
process.env.RETRY_BASE_MS = '10';
delete process.env.META_SYSTEM_TOKEN;

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../src/db');
const claude = require('../src/claude');
const whatsapp = require('../src/whatsapp');

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-test-'));
  return path.join(dir, 'kw.sqlite');
}

// Abre una base nueva (o reabre una existente = "reinicio del servicio").
function openDb(dbPath) {
  db.close();
  return db.open(dbPath);
}

// Claude falso: `responder(params, n)` devuelve el content de cada llamada.
function fakeClaude(responder) {
  const calls = [];
  claude.setClient({
    beta: {
      messages: {
        create: async (params) => {
          calls.push(JSON.parse(JSON.stringify(params)));
          return responder(params, calls.length);
        },
      },
    },
  });
  return calls;
}

// Respuesta típica: primera vuelta llama guardar_datos, segunda responde texto.
function toolThenText(input, texto) {
  return (params) => {
    const last = params.messages[params.messages.length - 1];
    const vieneDeTool = Array.isArray(last.content) && last.content[0]?.type === 'tool_result';
    if (!vieneDeTool && input) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${Math.random()}`, name: 'guardar_datos', input }] };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: texto }] };
  };
}

function captureSends() {
  const sent = [];
  whatsapp.sendMessage = async (to, text) => {
    sent.push({ to, text });
    return { messages: [{ id: `wamid.out.${sent.length}.${Math.random()}` }] };
  };
  whatsapp.sendMedia = async (to, tipo, mediaId, caption) => {
    sent.push({ to, tipo, mediaId, caption });
    return { messages: [{ id: `wamid.media.${sent.length}` }] };
  };
  return sent;
}

let seq = 0;
function waPayload(from, msg, { name = 'Cliente Test', referral = null } = {}) {
  seq += 1;
  const m = { from, id: msg.id || `wamid.in.${Date.now()}.${seq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...msg };
  if (referral) m.referral = referral;
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name } }], messages: [m] } }] }],
  };
}

const text = (body, extra = {}) => ({ type: 'text', text: { body }, ...extra });

module.exports = { tmpDbPath, openDb, fakeClaude, toolThenText, captureSends, waPayload, text, db };
