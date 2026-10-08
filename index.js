require('dotenv').config({ quiet: true });
const http = require('http');

const db = require('./src/db');
const whatsapp = require('./src/whatsapp');
const webhook = require('./src/webhook');
const agent = require('./src/agent');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function checkEnv() {
  const faltan = ['ANTHROPIC_API_KEY', 'WHATSAPP_VERIFY_TOKEN'].filter((k) => !process.env[k]);
  if (process.env.WHATSAPP_DRY_RUN !== '1') faltan.push(...['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'].filter((k) => !process.env[k]));
  if (faltan.length) console.warn(`[config] Faltan variables de entorno: ${faltan.join(', ')}`);
  if (!process.env.WHATSAPP_APP_SECRET) console.warn('[config] WHATSAPP_APP_SECRET no configurado: el webhook no verifica la firma de Meta');
  if (!process.env.META_SYSTEM_TOKEN) console.warn('[config] META_SYSTEM_TOKEN no configurado: no se resuelven las campañas de los anuncios');
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/webhook' && req.method === 'GET') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe'
        && url.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
      res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain' });
      res.end(ok ? url.searchParams.get('hub.challenge') : 'Forbidden');
      return;
    }

    if (url.pathname === '/webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!whatsapp.verifySignature(raw, req.headers['x-hub-signature-256'])) {
        console.error('[webhook] Firma inválida — rechazado');
        res.writeHead(403);
        res.end();
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch (e) {
        res.writeHead(400);
        res.end();
        return;
      }
      try {
        // Se persiste ANTES de responder 200: si falla, Meta reintenta y
        // el wa_message_id UNIQUE evita duplicados.
        webhook.handlePayload(payload);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      } catch (e) {
        console.error('[webhook] Error guardando el payload:', e);
        res.writeHead(500);
        res.end();
      }
      return;
    }

    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`[server] Escuchando en puerto ${PORT}`));
  return server;
}

if (require.main === module) {
  checkEnv();
  db.open();
  agent.recover();
  const server = startServer();

  // Railway manda SIGTERM en cada redeploy: dejar de aceptar y cerrar la base.
  process.on('SIGTERM', () => {
    console.log('[server] SIGTERM — cerrando');
    server.close();
    agent.idle().finally(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

module.exports = { startServer };
