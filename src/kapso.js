// Alta del webhook en Kapso (solo con WHATSAPP_PROVIDER=kapso).
//
// Kapso reenvía los mensajes del número al agente con el formato de Meta
// (webhook "kind: meta") y los firma con KAPSO_WEBHOOK_SECRET. Al arrancar el
// agente se asegura de que ese webhook exista, apunte a este servicio y use
// ese secreto, así nadie tiene que copiar secretos a mano en el panel.
//
// Solo hay un webhook "meta" por número. Si ya existe uno apuntando a OTRA
// URL no se toca: puede ser de otro sistema, y pisarlo cortaría sus mensajes.
const PLATFORM = 'https://api.kapso.ai/platform/v1';

function webhookUrl() {
  if (process.env.KAPSO_WEBHOOK_URL) return process.env.KAPSO_WEBHOOK_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook`;
  return null;
}

async function api(method, ruta, body) {
  const base = (process.env.KAPSO_PLATFORM_URL || PLATFORM).replace(/\/$/, '');
  const res = await fetch(`${base}${ruta}`, {
    method,
    headers: { 'X-API-Key': process.env.KAPSO_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Kapso ${method} ${ruta} → ${res.status}: ${texto.slice(0, 300)}`);
  return texto ? JSON.parse(texto) : null;
}

// Devuelve { estado: 'creado' | 'actualizado' | 'otra_url' | 'omitido', ... }. Nunca lanza.
async function ensureWebhook() {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const url = webhookUrl();
  const secret = process.env.KAPSO_WEBHOOK_SECRET;
  const faltan = [
    !process.env.KAPSO_API_KEY && 'KAPSO_API_KEY',
    !phoneId && 'WHATSAPP_PHONE_NUMBER_ID',
    !secret && 'KAPSO_WEBHOOK_SECRET',
    !url && 'KAPSO_WEBHOOK_URL (o el dominio público de Railway)',
  ].filter(Boolean);
  if (faltan.length) {
    console.warn(`[kapso] No se configura el webhook: faltan ${faltan.join(', ')}`);
    return { estado: 'omitido', faltan };
  }

  try {
    const ruta = `/whatsapp/phone_numbers/${encodeURIComponent(phoneId)}/webhooks`;
    const lista = await api('GET', `${ruta}?kind=meta`);
    const existente = (lista?.data || []).find((w) => (w.kind || 'meta') === 'meta');

    if (!existente) {
      const creado = await api('POST', ruta, { whatsapp_webhook: { kind: 'meta', url, secret_key: secret, active: true } });
      console.log(`[kapso] Webhook creado → ${url}`);
      return { estado: 'creado', id: creado?.data?.id };
    }
    if (existente.url !== url) {
      console.error(`[kapso] El número ya tiene un webhook apuntando a ${existente.url}. No se toca: cambialo en Kapso a ${url} o borralo y reiniciá el agente.`);
      return { estado: 'otra_url', url: existente.url };
    }
    await api('PATCH', `${ruta}/${existente.id}`, { whatsapp_webhook: { secret_key: secret, active: true } });
    console.log(`[kapso] Webhook verificado → ${url}`);
    return { estado: 'actualizado', id: existente.id };
  } catch (e) {
    console.error('[kapso] No se pudo configurar el webhook:', e.message);
    return { estado: 'error', error: e.message };
  }
}

module.exports = { ensureWebhook, webhookUrl };
