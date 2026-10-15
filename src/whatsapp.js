// Envío por WhatsApp Cloud API, directo a Meta o a través de Kapso, + modo
// prueba sin envíos reales.
//
// WHATSAPP_PROVIDER=meta  (por defecto) → graph.facebook.com con WHATSAPP_TOKEN;
//                                          webhook firmado por Meta (X-Hub-Signature-256).
// WHATSAPP_PROVIDER=kapso               → api.kapso.ai/meta/whatsapp con KAPSO_API_KEY;
//                                          webhook "kind: meta" firmado por Kapso
//                                          (X-Webhook-Signature, hex sin prefijo).
// En los dos casos el payload del webhook y el cuerpo de los envíos tienen el
// formato de Meta, así que el resto del agente no cambia.
const crypto = require('crypto');

const META_GRAPH_VERSION = 'v21.0';
const KAPSO_GRAPH_VERSION = 'v24.0';

// WHATSAPP_DRY_RUN=1 → no envía nada; loguea y devuelve un id falso.
const dryRun = () => process.env.WHATSAPP_DRY_RUN === '1';

const provider = () => (process.env.WHATSAPP_PROVIDER || 'meta').toLowerCase() === 'kapso' ? 'kapso' : 'meta';

// Los celulares de Argentina (549…) y México (521…) llegan en el webhook con
// un dígito extra que Meta no acepta como destinatario (error 131030 en la
// lista de permitidos). Se envía sin ese dígito. El wa_id guardado no cambia.
function normalizeTo(to) {
  const n = String(to);
  if (/^549\d{10}$/.test(n)) return `54${n.slice(3)}`;
  if (/^521\d{10}$/.test(n)) return `52${n.slice(3)}`;
  return n;
}

// URL y headers del endpoint de mensajes según el proveedor.
function endpoint() {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (provider() === 'kapso') {
    const base = (process.env.KAPSO_BASE_URL || 'https://api.kapso.ai/meta/whatsapp').replace(/\/$/, '');
    return {
      url: `${base}/${KAPSO_GRAPH_VERSION}/${phoneId}/messages`,
      headers: { 'X-API-Key': process.env.KAPSO_API_KEY, 'Content-Type': 'application/json' },
    };
  }
  return {
    url: `https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneId}/messages`,
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
  };
}

async function post(body) {
  if (body.to) body = { ...body, to: normalizeTo(body.to) };
  if (dryRun()) {
    const id = `wamid.dry.${crypto.randomUUID()}`;
    console.log(`[wa:dry] → ${body.to || body.message_id} (${body.type || 'escribiendo'}) ${body.text?.body || body.template?.name || ''}`);
    return { messages: [{ id }] };
  }
  const { url, headers } = endpoint();
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  if (!res.ok) throw new Error(`WhatsApp API (${provider()}) ${res.status}: ${await res.text()}`);
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

// Marca el mensaje del cliente como leído y muestra "escribiendo…" en su
// WhatsApp. Se apaga solo cuando llega la respuesta o a los 25 segundos.
async function sendTyping(messageId) {
  return post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
}

// Reenvía un documento o imagen recibido (por media_id de Meta) a otro número.
async function sendMedia(to, tipo, mediaId, caption) {
  const key = tipo === 'document' ? 'document' : 'image';
  const media = { id: mediaId };
  if (caption) media.caption = caption;
  return post({ to, type: key, [key]: media });
}

function iguales(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Verifica que el webhook venga de Meta o de Kapso, según el proveedor.
// headers: los headers del request (en minúscula, como los da Node).
// Sin secreto configurado no se puede verificar nada: solo se acepta en modo
// prueba (WHATSAPP_DRY_RUN=1).
function verifySignature(rawBody, headers = {}) {
  if (provider() === 'kapso') {
    const secret = process.env.KAPSO_WEBHOOK_SECRET;
    if (!secret) return dryRun();
    const firma = headers['x-webhook-signature'];
    if (!firma) return false;
    const esperada = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return iguales(esperada, String(firma).toLowerCase());
  }
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return dryRun();
  const firma = headers['x-hub-signature-256'];
  if (!firma) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return iguales(esperada, String(firma));
}

module.exports = { sendMessage, sendTemplate, sendMedia, sendTyping, verifySignature, normalizeTo, provider, endpoint };
