// Panel para KW: Chats (tablero Nuevos / Calificados / Derivados + detalle de
// cada conversación) y Stats (embudo, flujos, origen y leads por asesor).
//
// Solo lectura. Protegido con DASHBOARD_PASSWORD (Basic auth); sin esa
// variable las rutas no existen (404), así nada queda público por error.
const crypto = require('crypto');
const db = require('./db');
const config = require('../config/kw-py');
const catalogo = require('./catalogo');
const { calificacion } = require('./calificacion');
const { pendiente } = require('../prompts/kw-py');

const T = config.tenant_id;
const TZ = config.zonaHoraria;
const DIA_MS = 24 * 60 * 60 * 1000;

const FLUJOS = { compra: 'Compra', alquiler: 'Alquiler', captacion: 'Vende su propiedad', reclutamiento: 'Quiere ser asesor' };
const COLUMNAS = [
  { key: 'nuevos', label: 'Nuevos', ayuda: 'Conversando con el agente' },
  { key: 'calificados', label: 'Calificados', ayuda: 'Con los datos completos, por derivar' },
  { key: 'derivados', label: 'Derivados', ayuda: 'Ya enviados a un asesor' },
];
const PERIODOS = [{ dias: 7, label: '7 días' }, { dias: 30, label: '30 días' }, { dias: 0, label: 'Todo' }];

// ─── Utilidades ──────────────────────────────────────────────────────────────

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const digitos = (s) => String(s || '').replace(/\D/g, '');

function fecha(iso, conHora = true) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('es-PY', {
    timeZone: TZ, day: 'numeric', month: 'short', ...(conHora ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

function hace(iso) {
  if (!iso) return '';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

function dinero(monto, moneda) {
  if (!monto) return null;
  const n = Number(monto).toLocaleString('es-PY');
  return moneda === 'PYG' ? `Gs. ${n}` : `${moneda || ''} ${n}`.trim();
}

function pct(parte, total) {
  return total ? `${Math.round((parte / total) * 100)}%` : '-';
}

// Nombre de quien recibió el lead, a partir de su número (config actual).
function persona(numero) {
  const n = digitos(numero);
  const todas = [...(config.asesores || []), config.oficina, config.reclutamiento].filter((p) => p && !pendiente(p.whatsapp));
  const p = todas.find((x) => digitos(x.whatsapp) === n);
  return p ? p.nombre : `+${n}`;
}

const REGLAS = { flujo: 'Asesor del flujo', reclutamiento: 'Reclutamiento', oficina: 'Oficina' };

// ─── Datos ───────────────────────────────────────────────────────────────────

function parse(row) {
  return { ...row, datos: JSON.parse(row.datos || '{}'), referral: row.referral ? JSON.parse(row.referral) : null };
}

// Leads con al menos un mensaje del cliente. Los cerrados por #reiniciar son
// pruebas y no se muestran.
function leads(dias) {
  const desde = dias ? new Date(Date.now() - dias * DIA_MS).toISOString() : '';
  return db.get().prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM messages m WHERE m.lead_id = l.id AND m.direction = 'in') AS entrantes,
      (SELECT MAX(m.created_at) FROM messages m WHERE m.lead_id = l.id) AS ultimo_mensaje
    FROM leads l
    WHERE l.tenant_id = ? AND l.status <> 'cerrado' AND l.created_at >= ?
    ORDER BY COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.lead_id = l.id), l.updated_at) DESC
  `).all(T, desde).map(parse).filter((l) => l.entrantes > 0);
}

function derivacion(leadId) {
  const row = db.get().prepare("SELECT payload, created_at FROM lead_events WHERE lead_id = ? AND type = 'derived' ORDER BY rowid DESC LIMIT 1").get(leadId);
  return row ? { ...JSON.parse(row.payload || '{}'), fecha: row.created_at } : null;
}

function columna(lead) {
  if (lead.derived_at) return 'derivados';
  return calificacion(lead.flujo, lead.datos).qualified ? 'calificados' : 'nuevos';
}

function nombreLead(lead) {
  return lead.datos.nombre || lead.nombre_perfil || `+${lead.wa_id}`;
}

function resumenDatos(d) {
  const prop = d.propiedad_id ? catalogo.get(d.propiedad_id) : null;
  return [
    prop ? `${prop.tipo} · ${prop.barrio || prop.ciudad}` : d.tipo,
    !prop && d.zona,
    d.dormitorios && `${d.dormitorios} dorm.`,
    dinero(d.presupuesto, d.moneda),
    d.ciudad,
  ].filter(Boolean).join(' · ');
}

function origen(lead) {
  if (lead.source !== 'ctwa') return { anuncio: false, texto: 'Orgánico' };
  const r = lead.referral || {};
  return { anuncio: true, texto: lead.campaign_name || r.headline || r.body || 'Anuncio de Meta' };
}

// ─── Layout ──────────────────────────────────────────────────────────────────

function layout(titulo, activa, cuerpo, { refrescar = false } = {}) {
  const tab = (href, label, key) => `<a href="${href}" class="tab${activa === key ? ' on' : ''}">${label}</a>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refrescar ? '<meta http-equiv="refresh" content="60">' : ''}
<title>${esc(titulo)} · KW Paraguay</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=Poppins:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#EEF2FD;--surface:#fff;--ink:#0D1526;--muted:#6B7A9C;--line:#DDE3F5;--blue:#2762EA;--blue-tint:#EEF2FD;--green:#15803D;--green-tint:#DCFCE7;--amber:#B45309;--amber-tint:#FEF3C7;--red:#B42318;--bubble-in:#fff;--bubble-out:#DCE7FF}
@media (prefers-color-scheme:dark){:root{--bg:#060C18;--surface:#0D1526;--ink:#E8EEFF;--muted:#8A9BBE;--line:#1E2D4D;--blue:#4F80F0;--blue-tint:#131E35;--green:#4ADE80;--green-tint:#0F2A1B;--amber:#F0A84A;--amber-tint:#2A1D0E;--red:#F97066;--bubble-in:#131E35;--bubble-out:#1A2B4A}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:14px/1.45 Poppins,system-ui,sans-serif;min-height:100vh}
a{color:inherit}
.top{background:var(--surface);border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;gap:20px;flex-wrap:wrap;position:sticky;top:0;z-index:5}
.brand{font:800 17px Montserrat,sans-serif;color:var(--blue);letter-spacing:-.3px}
.brand small{display:block;font:500 11px Poppins,sans-serif;color:var(--muted);letter-spacing:0}
.tabs{display:flex;gap:4px;margin-left:auto}
.tab{text-decoration:none;font-weight:600;font-size:13px;padding:8px 14px;border-radius:8px;color:var(--muted)}
.tab.on{background:var(--blue-tint);color:var(--blue)}
main{max-width:1240px;margin:0 auto;padding:24px}
.bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.bar h1{font:800 20px Montserrat,sans-serif;margin-right:auto}
.pills{display:flex;gap:4px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:3px}
.pill{text-decoration:none;font-size:12px;font-weight:600;padding:6px 12px;border-radius:7px;color:var(--muted)}
.pill.on{background:var(--blue);color:#fff}
.meta{font-size:12px;color:var(--muted)}
.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}
@media (max-width:860px){.board{grid-template-columns:1fr}}
.col{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.col-h{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:8px}
.col-h b{font:700 14px Montserrat,sans-serif}
.col-h .n{font-weight:600;font-size:12px;background:var(--blue-tint);color:var(--blue);padding:1px 8px;border-radius:999px}
.col-h span.ayuda{margin-left:auto;font-size:11px;color:var(--muted)}
.col.calificados .col-h .n{background:var(--amber-tint);color:var(--amber)}
.col.derivados .col-h .n{background:var(--green-tint);color:var(--green)}
.cards{padding:10px;display:flex;flex-direction:column;gap:8px;max-height:72vh;overflow:auto}
.card{display:block;text-decoration:none;border:1px solid var(--line);border-radius:10px;padding:11px 12px;background:var(--surface)}
.card:hover{border-color:var(--blue)}
.card .r1{display:flex;justify-content:space-between;gap:8px}
.card .nom{font-weight:600}
.card .t{font-size:11px;color:var(--muted);white-space:nowrap}
.card .d{font-size:12px;color:var(--muted);margin-top:2px}
.tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px}
.tag{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--blue-tint);color:var(--blue)}
.tag.ad{background:var(--amber-tint);color:var(--amber)}
.tag.ok{background:var(--green-tint);color:var(--green)}
.vacio{padding:18px 8px;text-align:center;color:var(--muted);font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:20px}
@media (max-width:760px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px}
.kpi .v{font:800 28px Montserrat,sans-serif;line-height:1.1}
.kpi .l{font-size:12px;color:var(--muted);margin-top:4px}
.kpi .s{font-size:12px;font-weight:600;color:var(--blue);margin-top:2px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
@media (max-width:860px){.grid2{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
.panel h2{font:700 14px Montserrat,sans-serif;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:9px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
.funnel{display:flex;flex-direction:column;gap:8px}
.fl{display:grid;grid-template-columns:110px 1fr 60px;gap:10px;align-items:center;font-size:13px}
.track{background:var(--blue-tint);border-radius:6px;height:22px;overflow:hidden}
.fill{height:100%;background:var(--blue);border-radius:6px}
.fill.am{background:var(--amber)}.fill.gr{background:var(--green)}
.bars{display:flex;align-items:flex-end;gap:4px;height:110px;border-bottom:1px solid var(--line)}
.bars div{flex:1;background:var(--blue);border-radius:3px 3px 0 0;min-height:2px}
.bars-l{display:flex;gap:4px;margin-top:4px}
.bars-l span{flex:1;text-align:center;font-size:9px;color:var(--muted)}
.chat-wrap{display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px;align-items:start}
@media (max-width:860px){.chat-wrap{grid-template-columns:1fr}}
.ficha dt{font-size:11px;color:var(--muted);margin-top:10px}
.ficha dd{font-weight:500;word-break:break-word}
.msgs{display:flex;flex-direction:column;gap:8px;max-height:75vh;overflow:auto;padding:4px}
.b{max-width:78%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word;border:1px solid var(--line)}
.b.in{align-self:flex-start;background:var(--bubble-in);border-top-left-radius:3px}
.b.out{align-self:flex-end;background:var(--bubble-out);border-top-right-radius:3px;border-color:transparent}
.b .h{display:block;font-size:10.5px;color:var(--muted);margin-top:4px;text-align:right}
.volver{display:inline-block;margin-bottom:14px;font-size:13px;font-weight:600;color:var(--blue);text-decoration:none}
.aviso{background:var(--amber-tint);color:var(--amber);border-radius:10px;padding:10px 12px;font-size:12px;margin-top:12px}
</style></head><body>
<header class="top">
  <div class="brand">Keller Williams Paraguay<small>Asistente de WhatsApp · Sifer</small></div>
  <nav class="tabs">${tab('/conversaciones', '💬 Chats', 'chats')}${tab('/stats', '📊 Stats', 'stats')}</nav>
</header>
<main>${cuerpo}</main>
</body></html>`;
}

function selectorPeriodo(base, dias) {
  return `<div class="pills">${PERIODOS.map((p) => `<a class="pill${p.dias === dias ? ' on' : ''}" href="${base}?dias=${p.dias}">${p.label}</a>`).join('')}</div>`;
}

function leerDias(url, porDefecto) {
  const v = url.searchParams.get('dias');
  const n = v === null ? porDefecto : Number(v);
  return PERIODOS.some((p) => p.dias === n) ? n : porDefecto;
}

// ─── Chats ───────────────────────────────────────────────────────────────────

function tarjeta(lead) {
  const o = origen(lead);
  const der = lead.derived_at ? derivacion(lead.id) : null;
  const datos = resumenDatos(lead.datos);
  return `<a class="card" href="/conversaciones/chat?id=${encodeURIComponent(lead.id)}">
    <div class="r1"><span class="nom">${esc(nombreLead(lead))}</span><span class="t">${esc(hace(lead.ultimo_mensaje))}</span></div>
    <div class="d">+${esc(lead.wa_id)}</div>
    ${datos ? `<div class="d">${esc(datos)}</div>` : ''}
    <div class="tags">
      <span class="tag">${esc(FLUJOS[lead.flujo] || (lead.datos.derivar_oficina ? 'Para la oficina' : 'Sin definir'))}</span>
      ${o.anuncio ? '<span class="tag ad">📣 Anuncio</span>' : ''}
      ${der ? `<span class="tag ok">→ ${esc(persona(der.to))}</span>` : ''}
      ${lead.datos.pide_humano ? '<span class="tag">Pidió una persona</span>' : ''}
    </div>
  </a>`;
}

function renderChats(url) {
  const dias = leerDias(url, 30);
  const todos = leads(dias);
  const porCol = Object.fromEntries(COLUMNAS.map((c) => [c.key, []]));
  for (const l of todos) porCol[columna(l)].push(l);
  const cols = COLUMNAS.map((c) => `
    <section class="col ${c.key}">
      <div class="col-h"><b>${c.label}</b><span class="n">${porCol[c.key].length}</span><span class="ayuda">${c.ayuda}</span></div>
      <div class="cards">${porCol[c.key].map(tarjeta).join('') || '<div class="vacio">Sin conversaciones</div>'}</div>
    </section>`).join('');
  const cuerpo = `
    <div class="bar"><h1>Chats</h1><span class="meta">Se actualiza cada minuto · ${esc(fecha(new Date().toISOString()))}</span>${selectorPeriodo('/conversaciones', dias)}</div>
    <div class="board">${cols}</div>`;
  return layout('Chats', 'chats', cuerpo, { refrescar: true });
}

function renderChat(url) {
  const row = db.get().prepare('SELECT * FROM leads WHERE tenant_id = ? AND id = ?').get(T, url.searchParams.get('id') || '');
  if (!row) return null;
  const lead = parse(row);
  const o = origen(lead);
  const der = lead.derived_at ? derivacion(lead.id) : null;
  const { faltantes } = calificacion(lead.flujo, lead.datos);
  const prop = lead.datos.propiedad_id ? catalogo.get(lead.datos.propiedad_id) : null;
  const msgs = db.get().prepare(`
    SELECT direction, body, created_at FROM messages
    WHERE lead_id = ? AND body IS NOT NULL ORDER BY created_at, rowid
  `).all(lead.id);

  const d = lead.datos;
  const filas = [
    ['Teléfono', `<a href="https://wa.me/${esc(lead.wa_id)}" target="_blank" rel="noopener">+${esc(lead.wa_id)}</a>`],
    ['Estado', esc(COLUMNAS.find((c) => c.key === columna(lead)).label)],
    ['Consulta', esc(FLUJOS[lead.flujo] || (d.derivar_oficina ? 'Para la oficina' : 'Sin definir'))],
    ['Origen', o.anuncio ? `📣 ${esc(o.texto)}` : 'Orgánico'],
    prop && ['Propiedad consultada', `<a href="${esc(prop.url)}" target="_blank" rel="noopener">${esc(prop.tipo)} · ${esc(prop.barrio || prop.ciudad)} · ${esc(dinero(prop.precio, prop.moneda))}</a>`],
    d.tipo && !prop && ['Tipo', esc(d.tipo)],
    d.zona && !prop && ['Zona', esc(d.zona)],
    d.dormitorios && ['Dormitorios', esc(d.dormitorios)],
    d.presupuesto && ['Presupuesto', esc(dinero(d.presupuesto, d.moneda))],
    d.ciudad && ['Ciudad', esc(d.ciudad)],
    d.disponibilidad && ['Disponibilidad', esc(d.disponibilidad)],
    d.experiencia && ['Experiencia', esc(d.experiencia)],
    d.observacion && ['Observación', esc(d.observacion)],
    der && ['Derivado a', `${esc(persona(der.to))} · ${esc(fecha(der.fecha))}${der.motivo ? `<br><span class="meta">${esc(der.motivo)}</span>` : ''}`],
  ].filter(Boolean);

  const ficha = `
    <div class="panel">
      <h2>${esc(nombreLead(lead))}</h2>
      <dl class="ficha">${filas.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${!lead.derived_at && lead.flujo && faltantes.length ? `<div class="aviso">Falta para derivar: ${esc(faltantes.join(', '))}</div>` : ''}
    </div>`;
  const burbujas = msgs.map((m) => `<div class="b ${m.direction === 'in' ? 'in' : 'out'}">${esc(m.body)}<span class="h">${esc(fecha(m.created_at))}</span></div>`).join('');
  const cuerpo = `
    <a class="volver" href="/conversaciones">← Volver a Chats</a>
    <div class="chat-wrap">${ficha}
      <div class="panel"><h2>Conversación</h2><div class="msgs">${burbujas || '<div class="vacio">Sin mensajes</div>'}</div></div>
    </div>`;
  return layout(nombreLead(lead), 'chats', cuerpo);
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function renderStats(url) {
  const dias = leerDias(url, 30);
  const todos = leads(dias);
  const comerciales = todos.filter((l) => l.lead_type !== 'recruitment');
  const califica = (l) => !!l.derived_at || calificacion(l.flujo, l.datos).qualified;

  const total = todos.length;
  const calificados = todos.filter(califica).length;
  const derivados = todos.filter((l) => l.derived_at).length;
  const anuncios = todos.filter((l) => l.source === 'ctwa').length;

  const kpis = `
    <div class="kpis">
      <div class="kpi"><div class="v">${total}</div><div class="l">Leads atendidos</div></div>
      <div class="kpi"><div class="v">${calificados}</div><div class="l">Calificados</div><div class="s">${pct(calificados, total)} de los atendidos</div></div>
      <div class="kpi"><div class="v">${derivados}</div><div class="l">Derivados a un asesor</div><div class="s">${pct(derivados, total)} de los atendidos</div></div>
      <div class="kpi"><div class="v">${anuncios}</div><div class="l">Llegaron por anuncios</div><div class="s">${pct(anuncios, total)} del total</div></div>
    </div>`;

  const barra = (label, n, clase) => `<div class="fl"><span>${label}</span><div class="track"><div class="fill ${clase}" style="width:${total ? Math.max((n / total) * 100, n ? 2 : 0) : 0}%"></div></div><b class="num">${n}</b></div>`;
  const embudo = `<div class="panel"><h2>Embudo</h2><div class="funnel">${barra('Atendidos', total, '')}${barra('Calificados', calificados, 'am')}${barra('Derivados', derivados, 'gr')}</div></div>`;

  // Leads por asesor: cada derivación del período, agrupada por quien la recibió.
  const ids = new Set(todos.map((l) => l.id));
  const eventos = db.get().prepare(`
    SELECT e.lead_id, e.payload, e.created_at, l.flujo FROM lead_events e JOIN leads l ON l.id = e.lead_id
    WHERE l.tenant_id = ? AND e.type = 'derived' ORDER BY e.created_at
  `).all(T).filter((e) => ids.has(e.lead_id)).map((e) => ({ ...e, p: JSON.parse(e.payload || '{}') }));
  const porAsesor = new Map();
  for (const e of eventos) {
    const clave = digitos(e.p.to) || 'sin-numero';
    const a = porAsesor.get(clave) || { nombre: persona(e.p.to), total: 0, compra: 0, alquiler: 0, captacion: 0, reclutamiento: 0, oficina: 0, ultimo: null };
    a.total += 1;
    if (e.flujo && a[e.flujo] !== undefined) a[e.flujo] += 1; else a.oficina += 1;
    a.ultimo = e.created_at;
    porAsesor.set(clave, a);
  }
  const filasAsesor = [...porAsesor.values()].sort((x, y) => y.total - x.total).map((a) => `
    <tr><td><b>${esc(a.nombre)}</b></td><td class="num"><b>${a.total}</b></td><td class="num">${a.compra}</td><td class="num">${a.alquiler}</td>
    <td class="num">${a.captacion}</td><td class="num">${a.reclutamiento}</td><td class="num">${a.oficina}</td><td>${esc(hace(a.ultimo))}</td></tr>`).join('');
  const asesores = `
    <div class="panel"><h2>Leads recibidos por asesor</h2>
      ${filasAsesor ? `<div style="overflow-x:auto"><table><thead><tr><th>Asesor</th><th class="num">Total</th><th class="num">Compra</th><th class="num">Alquiler</th>
      <th class="num">Vende</th><th class="num">Asesor KW</th><th class="num">Otros</th><th>Último</th></tr></thead><tbody>${filasAsesor}</tbody></table></div>`
        : '<div class="vacio">Todavía no hay derivaciones en este período</div>'}
    </div>`;

  const filasFlujo = Object.entries(FLUJOS).map(([k, label]) => {
    const g = todos.filter((l) => l.flujo === k);
    return `<tr><td>${label}</td><td class="num">${g.length}</td><td class="num">${g.filter(califica).length}</td><td class="num">${g.filter((l) => l.derived_at).length}</td></tr>`;
  }).join('');
  const sinFlujo = todos.filter((l) => !l.flujo).length;
  const flujos = `<div class="panel"><h2>Por tipo de consulta</h2><table><thead><tr><th>Consulta</th><th class="num">Atendidos</th><th class="num">Calificados</th><th class="num">Derivados</th></tr></thead>
    <tbody>${filasFlujo}<tr><td>Sin definir</td><td class="num">${sinFlujo}</td><td class="num">-</td><td class="num">${todos.filter((l) => !l.flujo && l.derived_at).length}</td></tr></tbody></table></div>`;

  const porAnuncio = new Map();
  for (const l of todos.filter((x) => x.source === 'ctwa')) {
    const k = origen(l).texto;
    const a = porAnuncio.get(k) || { n: 0, der: 0 };
    a.n += 1; if (l.derived_at) a.der += 1;
    porAnuncio.set(k, a);
  }
  const filasAnuncio = [...porAnuncio.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)
    .map(([k, a]) => `<tr><td>${esc(k)}</td><td class="num">${a.n}</td><td class="num">${a.der}</td></tr>`).join('');
  const origenHtml = `<div class="panel"><h2>Origen</h2>
    <table><tbody><tr><td>📣 Anuncios de Meta</td><td class="num"><b>${anuncios}</b></td></tr><tr><td>Orgánico</td><td class="num"><b>${total - anuncios}</b></td></tr></tbody></table>
    ${filasAnuncio ? `<h2 style="margin-top:16px">Por anuncio</h2><table><thead><tr><th>Anuncio</th><th class="num">Leads</th><th class="num">Derivados</th></tr></thead><tbody>${filasAnuncio}</tbody></table>` : ''}
  </div>`;

  // Leads nuevos por día (últimos 14 días, sin depender del período).
  const dias14 = [];
  for (let i = 13; i >= 0; i--) dias14.push(new Date(Date.now() - i * DIA_MS).toLocaleDateString('en-CA', { timeZone: TZ }));
  const conteo = Object.fromEntries(dias14.map((d) => [d, 0]));
  for (const l of leads(14)) {
    const d = new Date(l.created_at).toLocaleDateString('en-CA', { timeZone: TZ });
    if (d in conteo) conteo[d] += 1;
  }
  const max = Math.max(1, ...Object.values(conteo));
  const serie = `<div class="panel"><h2>Leads nuevos por día · últimos 14 días</h2>
    <div class="bars">${dias14.map((d) => `<div title="${d}: ${conteo[d]}" style="height:${(conteo[d] / max) * 100}%"></div>`).join('')}</div>
    <div class="bars-l">${dias14.map((d) => `<span>${Number(d.slice(8))}</span>`).join('')}</div></div>`;

  const cuerpo = `
    <div class="bar"><h1>Stats</h1><span class="meta">${comerciales.length} comerciales · ${total - comerciales.length} postulantes</span>${selectorPeriodo('/stats', dias)}</div>
    ${kpis}
    <div class="grid2"><div>${embudo}${flujos}</div><div>${asesores}${origenHtml}</div></div>
    ${serie}`;
  return layout('Stats', 'stats', cuerpo, { refrescar: true });
}

// ─── Rutas ───────────────────────────────────────────────────────────────────

function autorizado(req) {
  const pass = process.env.DASHBOARD_PASSWORD;
  const [tipo, valor] = String(req.headers.authorization || '').split(' ');
  if (tipo !== 'Basic' || !valor) return false;
  const dado = Buffer.from(valor, 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(dado).digest();
  const b = crypto.createHash('sha256').update(pass).digest();
  return crypto.timingSafeEqual(a, b);
}

// Devuelve true si atendió la ruta.
function handle(req, res, url) {
  const rutas = { '/conversaciones': renderChats, '/conversaciones/chat': renderChat, '/stats': renderStats };
  const render = rutas[url.pathname];
  if (!render || req.method !== 'GET') return false;
  if (!process.env.DASHBOARD_PASSWORD) return false; // sin contraseña, el panel no existe
  if (!autorizado(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="KW Paraguay", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acceso restringido');
    return true;
  }
  const html = render(url);
  if (html === null) { res.writeHead(404); res.end(); return true; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
  res.end(html);
  return true;
}

module.exports = { handle, columna, renderChats, renderStats, renderChat };
