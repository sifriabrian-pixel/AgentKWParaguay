// Panel de KW: las mismas pantallas del panel Sifer v2 (Resumen, Leads y, solo
// para Sifer, Salud del agente), servidas por el agente con datos en vivo.
//
// Dos roles, decididos por la contraseña (Basic auth):
//   DASHBOARD_PASSWORD → equipo de KW
//   ADMIN_PASSWORD     → Sifer (además ve Salud del agente)
// Sin DASHBOARD_PASSWORD ni ADMIN_PASSWORD el panel no existe (404).
const crypto = require('crypto');
const { CLIENTES } = require('./clientes');
const datos = require('./datos');
const { resolverPeriodo } = require('./tiempo');
const { renderResumen } = require('./vistas/resumen');
const { renderLeads, generarCsv } = require('./vistas/leads');
const { renderSalud } = require('./vistas/salud');

const cliente = CLIENTES.kw;
const BASE = `/${cliente.id}`;

function igual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function rolDe(req) {
  const [tipo, valor = ''] = String(req.headers.authorization || '').split(' ');
  if (tipo !== 'Basic') return null;
  const pass = Buffer.from(valor, 'base64').toString('utf8').split(':').slice(1).join(':');
  if (process.env.ADMIN_PASSWORD && igual(pass, process.env.ADMIN_PASSWORD)) return 'admin';
  if (process.env.DASHBOARD_PASSWORD && igual(pass, process.env.DASHBOARD_PASSWORD)) return 'cliente';
  return null;
}

function leerBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

function enviar(res, status, cuerpo, tipo = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
  res.end(cuerpo);
}

// Solo se vuelve a rutas internas del panel.
function volverSeguro(valor) {
  return typeof valor === 'string' && valor.startsWith(`${BASE}/`) && !valor.startsWith('//') ? valor : `${BASE}/leads`;
}

const RUTAS_VIEJAS = { '/conversaciones': `${BASE}/leads`, '/stats': `${BASE}/resumen` };

// Devuelve true si atendió la ruta.
async function handle(req, res, url) {
  const esPanel = url.pathname === BASE || url.pathname.startsWith(`${BASE}/`) || url.pathname in RUTAS_VIEJAS;
  if (!esPanel) return false;
  if (!process.env.DASHBOARD_PASSWORD && !process.env.ADMIN_PASSWORD) return false; // sin contraseña, el panel no existe

  const rol = rolDe(req);
  if (!rol) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Sifer", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acceso restringido');
    return true;
  }

  // Links de antes (/conversaciones y /stats) y la raíz del panel.
  if (url.pathname in RUTAS_VIEJAS || url.pathname === BASE || url.pathname === `${BASE}/`) {
    res.writeHead(302, { Location: RUTAS_VIEJAS[url.pathname] || `${BASE}/resumen` });
    res.end();
    return true;
  }

  try {
    const ruta = url.pathname.slice(BASE.length);
    const modelo = datos.cargar(cliente);
    const clientesDisponibles = [cliente.id];
    const periodoDe = (porDefecto) => resolverPeriodo({
      preset: url.searchParams.get('p') || porDefecto,
      desde: url.searchParams.get('desde'),
      hasta: url.searchParams.get('hasta'),
    }, cliente.timezone);

    if (req.method === 'GET' && ruta === '/resumen') {
      enviar(res, 200, renderResumen({ cliente, clientesDisponibles, modelo, periodo: periodoDe('7'), rol }));
      return true;
    }
    if (req.method === 'GET' && ruta === '/salud') {
      if (rol !== 'admin') enviar(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
      else enviar(res, 200, renderSalud({ cliente, clientesDisponibles, modelo, periodo: periodoDe('7'), rol }));
      return true;
    }
    if (req.method === 'GET' && ruta === '/leads') {
      enviar(res, 200, renderLeads({ cliente, clientesDisponibles, modelo, params: url.searchParams, periodo: periodoDe('30'), rol }));
      return true;
    }
    if (req.method === 'GET' && ruta === '/leads.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads_kw.csv"', 'Cache-Control': 'no-store' });
      res.end(generarCsv(cliente, modelo, url.searchParams, periodoDe('30')));
      return true;
    }

    if (req.method === 'POST' && ['/marcar', '/nota', '/asesor'].includes(ruta)) {
      const body = await leerBody(req);
      const numero = body.get('numero') || '';
      if (!modelo.porNumero.has(numero)) { enviar(res, 400, 'Lead inválido', 'text/plain; charset=utf-8'); return true; }
      const usuario = rol === 'admin' ? 'Sifer' : 'Equipo KW';
      if (ruta === '/marcar') datos.marcar(cliente.id, numero, body.get('prioridad') || '', usuario);
      else if (ruta === '/nota') datos.guardarNota(cliente.id, numero, body.get('nota'), usuario);
      else {
        try {
          datos.cambiarAsesor(cliente.id, numero, body.get('asesor') || '', usuario);
        } catch (e) {
          enviar(res, 400, JSON.stringify({ ok: false, error: e.message }), 'application/json; charset=utf-8');
          return true;
        }
        if ((req.headers.accept || '').includes('application/json')) {
          enviar(res, 200, JSON.stringify({ ok: true, usuario }), 'application/json; charset=utf-8');
          return true;
        }
      }
      const volver = new URL(volverSeguro(body.get('volver')), 'http://localhost');
      volver.searchParams.set('numero', numero);
      res.writeHead(303, { Location: volver.pathname + volver.search });
      res.end();
      return true;
    }

    enviar(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
  } catch (e) {
    console.error('[panel]', e);
    enviar(res, 500, 'Error interno', 'text/plain; charset=utf-8');
  }
  return true;
}

module.exports = { handle };
