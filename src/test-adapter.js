// Adapter de test: corre el core real sobre una base en memoria y solo
// registra las acciones. No carga whatsapp.js: no puede enviar nada.
//
//   const adapter = createTestAdapter({ ads: { 'ad-1': 'KWPY | COMPRA | Luque' } });
//   const out = await adapter.handleMessage({ conversationId, from, text, now, metadata });
//
// Una sola instancia por proceso (la base es única por proceso).
const crypto = require('crypto');
const db = require('./db');
const catalogo = require('./catalogo');
const core = require('./core');
const claude = require('./claude');
const { buildSystemPrompt } = require('../prompts/kw-py');

const CREDENCIALES = ['WHATSAPP_TOKEN', 'META_SYSTEM_TOKEN'];

// ads: { adId: 'nombre de campaña' | { campaign_name, ... } } — reemplaza a la Meta Marketing API.
// catalogoArchivo: JSON de propiedades (por defecto, el de config).
// llm: reemplazo de src/claude.js ({ chat }); por defecto, Claude real.
function createTestAdapter({ ads = {}, catalogoArchivo, llm } = {}) {
  const presentes = CREDENCIALES.filter((k) => process.env[k]);
  if (presentes.length) throw new Error(`Adapter de test: hay credenciales reales en el entorno (${presentes.join(', ')}). Quitarlas antes de correr.`);

  db.close();
  db.open(':memory:');
  catalogo.sync(catalogoArchivo);

  const resolveAd = async (adId) => {
    const ad = ads[adId];
    if (!ad) return null;
    const base = { campaign_id: `fixture-${adId}`, campaign_name: null, adset_name: null, ad_name: null };
    return typeof ad === 'string' ? { ...base, campaign_name: ad } : { ...base, ...ad };
  };
  const deps = { resolveAd, llm };
  const actions = []; // todo lo que el agente habría ejecutado, en orden

  const registrar = (conversationId, out) => {
    for (const action of out.actions) actions.push({ conversationId, ...action });
    return out;
  };

  return {
    actions,
    handleMessage: async (input) => registrar(input.conversationId, await core.handleMessage(input, deps)),
    tick: async (conversationId, now) => registrar(conversationId, await core.tick(conversationId, now, deps)),
    // Versión de lo que se está testeando: prompt + herramientas + modelo.
    promptHash: () => crypto.createHash('sha256').update(buildSystemPrompt()).update(JSON.stringify(claude.TOOLS)).update(claude.MODEL).digest('hex').slice(0, 12),
    close: () => db.close(),
  };
}

module.exports = { createTestAdapter };
