// WhatsApp Cloud API (igual que Impacta) + modo prueba sin envíos reales.
const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';

// WHATSAPP_DRY_RUN=1 → no llama a Meta; loguea y devuelve un id falso.
const dryRun = () => process.env.WHATSAPP_DRY_RUN === '1';

async function post(body) {
  if (dryRun()) {
    const id = `wamid.dry.${crypto.randomUUID()}`;
    console.log(`[wa:dry] → ${body.to} (${body.type}) ${body.text?.body || body.template?.name || ''}`);
    return { messages: [{ id }] };
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json?.messages?.[0]?.message_status === 'failed') {
    throw new Error(`WhatsApp mensaje rechazado: ${JSON.stringify(json)}`);
  }
  return json;
}

async function sendMessage(to, text) {
  return post({ to, type: 'text', text: { body: text } });
}

// Plantilla aprobada (obligatoria fuera de la ventana de 24 hs).
// parametros: { nombreVariable: valor } — las variables numéricas ({{1}}) no llevan parameter_name.
async function sendTemplate(to, nombrePlantilla, idioma, parametros = {}) {
  const body = { to, type: 'template', template: { name: nombrePlantilla, language: { code: idioma } } };
  const nombres = Object.keys(parametros);
  if (nombres.length > 0) {
    body.template.components = [{
      type: 'body',
      parameters: nombres.map((n) => {
        const p = { type: 'text', text: String(parametros[n]) };
        if (!/^\d+$/.test(n)) p.parameter_name = n;
        return p;
      }),
    }];
  }
  return post(body);
}

// Reenvía un documento o imagen recibido (por media_id de Meta) a otro número.
async function sendMedia(to, tipo, mediaId, caption) {
  const key = tipo === 'document' ? 'document' : 'image';
  const media = { id: mediaId };
  if (caption) media.caption = caption;
  return post({ to, type: key, [key]: media });
}

// Verifica la firma HMAC del webhook con el App Secret.
function verifySignature(rawBody, signatureHeader) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return true;
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { sendMessage, sendTemplate, sendMedia, verifySignature };
