// Layout, estilos y helpers de HTML compartidos por todas las pantallas.
// Todo texto que venga de los datos (mensajes, nombres, notas) pasa por esc():
// el panel viejo lo imprimía crudo y un lead podía inyectar HTML.

const { CLIENTES } = require('./clientes');
const { tiempoRelativo } = require('./tiempo');

function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Arma un query string ignorando valores vacíos
function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') s.set(k, v);
  const txt = s.toString();
  return txt ? '?' + txt : '';
}

function numero(n) {
  return n == null ? '—' : Number(n).toLocaleString('es-EC');
}

const CSS = `
:root{
  --navy:#0D1B2A; --navy-2:#162235; --blue:#2762EA; --blue-soft:#EAF0FD; --blue-ink:#1E4FC2;
  --naranja:#E08A1E; --bg:#F3F5F9; --card:#FFFFFF; --line:#E4E8EF; --line-2:#EEF1F5;
  --ink:#0D1B2A; --ink-2:#4A5568; --ink-3:#8A94A6;
  --rojo:#C62828; --rojo-soft:#FDECEC; --verde:#15803D; --verde-soft:#E8F6EE;
  --gris-soft:#F1F3F6; --radio:12px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 'Poppins',system-ui,sans-serif}
a{color:var(--blue);text-decoration:none}
h1,h2,h3{font-family:'Montserrat',sans-serif;margin:0;color:var(--ink)}
h2{font-size:15px;font-weight:700}
.tabnum{font-variant-numeric:tabular-nums}

/* Header */
.top{background:var(--navy);color:#fff;position:sticky;top:0;z-index:20}
.top-in{max-width:1180px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.marca{display:flex;flex-direction:column;line-height:1.1;margin-right:auto}
.marca b{font-family:'Montserrat',sans-serif;font-weight:800;font-size:18px}
.marca b span{color:#6C95F7}
.marca small{color:#9AA7BD;font-size:11px;margin-top:2px}
.marca select{background:transparent;color:#9AA7BD;border:0;font:inherit;font-size:11px;padding:0;margin-top:2px;cursor:pointer}
.marca select option{color:var(--ink)}
.nav{display:flex;gap:4px;background:var(--navy-2);padding:3px;border-radius:10px}
.nav a{color:#C9D3E3;padding:6px 14px;border-radius:8px;font-weight:600;font-size:13px}
.nav a.on{background:var(--blue);color:#fff}

.barra{max-width:1180px;margin:0 auto;padding:12px 16px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{border:1px solid var(--line);background:var(--card);color:var(--ink-2);padding:5px 11px;border-radius:999px;font-size:12px;font-weight:600;cursor:pointer}
.chip.on{background:var(--blue);border-color:var(--blue);color:#fff}
details.custom{position:relative}
details.custom summary{list-style:none}
details.custom summary::-webkit-details-marker{display:none}
details.custom form{position:absolute;top:34px;right:0;flex-wrap:wrap;max-width:calc(100vw - 32px);z-index:10;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;display:flex;gap:6px;align-items:center;box-shadow:0 8px 24px rgba(13,27,42,.12);white-space:nowrap}
.actualizado{margin-left:auto;color:var(--ink-3);font-size:11px}

main{max-width:1180px;margin:0 auto;padding:12px 16px 40px}
.seccion{margin-top:18px}
.seccion-cab{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.seccion-cab small{color:var(--ink-3);font-size:11px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radio);padding:14px}
.grid2{display:grid;gap:12px;grid-template-columns:1fr}
@media(min-width:760px){.grid2{grid-template-columns:1fr 1fr}}

/* KPIs */
.kpis{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media(min-width:760px){.kpis{grid-template-columns:repeat(4,1fr);gap:12px}}
@media(max-width:420px){.kpis .kpi{padding:9px 10px}.kpis .kpi-v{font-size:22px}}
@media(max-width:420px){.nav a{padding:6px 10px}}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radio);padding:10px 12px;display:block;color:inherit}
.kpi-l{font-size:11px;color:var(--ink-2);font-weight:600}
.kpi-v{font-family:'Montserrat',sans-serif;font-size:26px;font-weight:800;line-height:1.15;margin-top:2px}
.kpi-s{font-size:11px;color:var(--ink-3);display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:2px}
.delta{font-weight:700;font-size:11px;padding:0 6px;border-radius:999px}
.delta.bien{color:var(--verde);background:var(--verde-soft)}
.delta.mal{color:var(--rojo);background:var(--rojo-soft)}
.delta.igual{color:var(--ink-3);background:var(--gris-soft)}
.kpi.alerta{border-color:var(--rojo);background:var(--rojo-soft)}
.kpi.alerta .kpi-v,.kpi.alerta .kpi-l{color:var(--rojo)}
.kpi.ok .kpi-v{color:var(--verde)}
.kpi.ancho{grid-column:1/-1}
@media(min-width:760px){.kpi.ancho{grid-column:auto}}

/* Funnel */
.funnel{display:flex;flex-direction:column;gap:2px}
.f-fila{display:grid;grid-template-columns:96px 1fr 44px;align-items:center;gap:10px}
.f-fila span{font-size:12px;color:var(--ink-2)}
.f-bar{height:22px;background:var(--line-2);border-radius:4px;overflow:hidden}
.f-bar i{display:block;height:100%;background:var(--blue);border-radius:0 4px 4px 0}
.f-fila b{text-align:right;font-size:14px}
.f-conv{padding-left:106px;font-size:11px;color:var(--ink-3);line-height:1.6}
@media(min-width:760px){
  .funnel{flex-direction:row;align-items:stretch;gap:0}
  .f-paso{flex:1;text-align:center;padding:8px 6px}
  .f-paso .f-n{font-family:'Montserrat',sans-serif;font-size:24px;font-weight:800}
  .f-flecha{display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--ink-3);font-size:12px;padding:0 4px}
}

/* Listas */
.lista{list-style:none;margin:0;padding:0}
.item{display:flex;gap:10px;align-items:center;padding:10px 4px;border-top:1px solid var(--line-2);color:inherit}
.item:first-child{border-top:0}
.item:hover{background:#FAFBFD}
.item-main{flex:1;min-width:0}
.item-t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item-s{font-size:12px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.espera{font-weight:700;font-size:13px;white-space:nowrap}
.espera.alta{color:var(--rojo)}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--gris-soft);color:var(--ink-2);white-space:nowrap}
.tag.rojo{background:var(--rojo-soft);color:var(--rojo)}
.tag.azul{background:var(--blue-soft);color:var(--blue-ink)}
.tag.verde{background:var(--verde-soft);color:var(--verde)}
.tag.violeta{background:#EFE9FD;color:#6D28D9}
.vacio{color:var(--ink-3);font-size:13px;padding:14px 4px}
.ver-todos{display:block;text-align:center;font-weight:600;font-size:13px;padding:10px 0 2px;border-top:1px solid var(--line-2)}

/* Tablas → tarjetas en mobile */
table.t{width:100%;border-collapse:collapse;font-size:13px}
table.t th{text-align:left;font-size:11px;color:var(--ink-3);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line)}
table.t td{padding:9px 8px;border-bottom:1px solid var(--line-2);vertical-align:middle}
table.t td.n,table.t th.n{text-align:right;font-variant-numeric:tabular-nums}
table.t tr.click{cursor:pointer}
table.t tr.click:hover td{background:#FAFBFD}
@media(max-width:759px){
  table.t thead{display:none}
  table.t,table.t tbody,table.t tr,table.t td{display:block;width:100%}
  table.t tr{border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:var(--card)}
  table.t td{border:0;padding:3px 0;display:flex;justify-content:space-between;gap:10px;text-align:right}
  table.t td::before{content:attr(data-l);color:var(--ink-3);font-size:12px;text-align:left}
  table.t td.n{text-align:right}
  table.t td.prim{font-weight:700;font-size:14px}
  table.t td.prim::before{content:none}
}

/* Barras horizontales (distribuciones) */
.barras{display:flex;flex-direction:column;gap:7px}
.b-fila{display:grid;grid-template-columns:minmax(0,1.3fr) 2fr 40px;gap:8px;align-items:center;font-size:12px}
.b-fila span{color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.b-bar{height:12px;background:var(--line-2);border-radius:3px}
.b-bar i{display:block;height:100%;background:var(--blue);border-radius:0 4px 4px 0;min-width:2px}
.b-fila.gris i{background:#B8C0CC}
.b-fila.gris span{font-style:italic}
.b-fila b{text-align:right;font-variant-numeric:tabular-nums}
.sub-h{font-size:12px;font-weight:700;color:var(--ink-2);margin:14px 0 8px}
.sub-h:first-child{margin-top:0}

/* Tiles */
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media(min-width:760px){.tiles{grid-template-columns:repeat(4,1fr);gap:12px}}
.tile{background:var(--card);border:1px solid var(--line);border-radius:var(--radio);padding:12px}
.tile-v{font-family:'Montserrat',sans-serif;font-size:22px;font-weight:800}
.tile-l{font-size:12px;color:var(--ink-2);font-weight:600}
.tile-s{font-size:11px;color:var(--ink-3);margin-top:2px}

/* Gráfico */
.chart svg{width:100%;max-width:820px;height:auto;display:block}
.leyenda{display:flex;gap:14px;font-size:12px;color:var(--ink-2);margin-bottom:6px}
.leyenda i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.chart .hit:hover{fill:rgba(39,98,234,.06)}
details.tabla summary{font-size:12px;color:var(--blue);cursor:pointer;margin-top:6px}

/* Leads */
.filtros{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.filtros input,.filtros select,.sel{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);max-width:100%}
.filtros input[type=search]{flex:1 1 200px}
.btn{font:inherit;font-size:13px;font-weight:600;padding:7px 14px;border-radius:8px;border:1px solid var(--blue);background:var(--blue);color:#fff;cursor:pointer;display:inline-block}
.btn.sec{background:var(--card);color:var(--blue)}
.paginas{display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:12px;color:var(--ink-3)}

/* Kanban: columnas con scroll vertical propio; en mobile se desliza en horizontal */
.kb{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(210px,1fr);gap:10px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x proximity}
.kb-col{background:#E9EDF3;border-radius:12px;display:flex;flex-direction:column;min-width:0;scroll-snap-align:start}
.kb-cab{padding:10px 12px;display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:13px;font-family:'Montserrat',sans-serif}
.kb-cab span{background:var(--card);border-radius:999px;padding:1px 9px;font-size:11px;color:var(--ink-2);font-family:'Poppins',sans-serif}
.kb-body{overflow-y:auto;height:calc(100vh - 300px);min-height:320px;padding:0 8px 8px;display:flex;flex-direction:column;gap:6px}
.kb-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 10px;color:inherit;display:block;flex-shrink:0}
.kb-card:hover{border-color:var(--blue)}
.kb-t{display:flex;justify-content:space-between;align-items:baseline;gap:6px;font-weight:600;font-size:13px}
.kb-t span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-t small{color:var(--ink-3);font-size:10.5px;font-weight:400;flex-shrink:0}
.kb-s{font-size:11.5px;color:var(--ink-2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.kb-anuncio{color:var(--blue-ink)}
.kb-tags:empty{display:none}
@media(max-width:759px){.kb{grid-auto-columns:84vw}.kb-body{height:calc(100vh - 360px)}}

.tile.alerta{border-color:var(--rojo);background:var(--rojo-soft)}
.tile.alerta .tile-v,.tile.alerta .tile-l{color:var(--rojo)}

/* Desplegable de asesor en la ficha */
.form-asesor{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:-3px 0}
.form-asesor .sel{padding:4px 8px}
.guardado{font-size:11px;color:var(--verde);font-weight:600}

/* Drawer */
.velo{position:fixed;inset:0;background:rgba(13,27,42,.35);z-index:40}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(520px,100%);background:var(--card);z-index:41;display:flex;flex-direction:column;box-shadow:-10px 0 30px rgba(13,27,42,.15)}
.d-cab{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:flex-start}
.d-cab h2{font-size:17px}
.d-cerrar{margin-left:auto;font-size:22px;line-height:1;color:var(--ink-3);padding:2px 6px}
.d-cuerpo{overflow-y:auto;padding:14px 16px 30px;flex:1}
.d-sec{margin-bottom:18px}
.d-sec h3{font-size:12px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
.datos{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px}
.datos dt{color:var(--ink-3)}
.datos dd{margin:0;word-break:break-word}
.marcas{display:flex;gap:6px;flex-wrap:wrap}
.marcas button{font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);cursor:pointer;color:var(--ink-2)}
.marcas button.on{border-color:currentColor;font-weight:700}
.nota textarea{width:100%;font:inherit;font-size:13px;padding:8px;border:1px solid var(--line);border-radius:8px;resize:vertical;min-height:64px}
.timeline{list-style:none;margin:0;padding:0;border-left:2px solid var(--line);margin-left:5px}
.timeline li{position:relative;padding:0 0 10px 14px;font-size:12px}
.timeline li::before{content:'';position:absolute;left:-6px;top:4px;width:10px;height:10px;border-radius:50%;background:var(--card);border:2px solid var(--blue)}
.timeline li.panel::before{border-color:#6D28D9}
.timeline time{color:var(--ink-3);display:block;font-size:11px}
.chat{background:#F7F8FA;border-radius:10px;padding:8px}
.burbuja{max-width:85%;padding:7px 10px;border-radius:12px;font-size:12.5px;margin:5px 0;white-space:pre-wrap;word-break:break-word}
.burbuja.u{background:#fff;border:1px solid var(--line)}
.burbuja.a{background:var(--navy);color:#fff;margin-left:auto}
.burbuja small{display:block;font-size:10px;opacity:.7;text-align:right;margin-top:3px}
.sep-fecha{text-align:center;margin:10px 0 4px}
.sep-fecha span{background:#E6E9EE;color:var(--ink-2);font-size:10px;padding:2px 10px;border-radius:999px}
.aviso{font-size:12px;padding:8px 10px;border-radius:8px;background:var(--blue-soft);color:var(--blue-ink);margin-bottom:8px}
.aviso.violeta{background:#F5F3FF;color:#6D28D9}
`;

function selectorPeriodo(base, periodo, extra = {}) {
  const opciones = [['7', '7 días'], ['30', '30 días'], ['mes', 'Este mes']];
  const chips = opciones.map(([p, label]) =>
    `<a class="chip ${periodo.preset === p ? 'on' : ''}" href="${esc(base + qs({ ...extra, p }))}">${label}</a>`).join('');
  const esCustom = periodo.preset === 'custom';
  return `
    <div class="chips" role="group" aria-label="Período">
      ${chips}
      <details class="custom">
        <summary class="chip ${esCustom ? 'on' : ''}">${esCustom ? esc(periodo.etiqueta) : 'Personalizado'}</summary>
        <form method="GET" action="${esc(base)}">
          ${Object.entries(extra).filter(([, v]) => v).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
          <input type="hidden" name="p" value="custom">
          <input type="date" name="desde" value="${esc(periodo.desde || '')}" required aria-label="Desde">
          <input type="date" name="hasta" value="${esc(periodo.hasta || '')}" aria-label="Hasta">
          <button class="btn" type="submit">Aplicar</button>
        </form>
      </details>
    </div>`;
}

function layout({ cliente, clientesDisponibles, activo, titulo, barra = '', contenido, ultimoDato, refrescar = true, rol = 'cliente' }) {
  const selector = clientesDisponibles.length > 1
    ? `<select aria-label="Cliente" onchange="location.href='/'+this.value+'/${activo === 'resumen' ? 'resumen' : activo}'">
        ${clientesDisponibles.map((id) => `<option value="${id}" ${id === cliente.id ? 'selected' : ''}>${esc(CLIENTES[id].nombre)} · ${esc(CLIENTES[id].ubicacion)}</option>`).join('')}
      </select>`
    : `<small>${esc(cliente.nombre)} · ${esc(cliente.ubicacion)}</small>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · ${esc(cliente.nombre)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230D1B2A'/%3E%3Ctext x='16' y='23' font-family='Montserrat,sans-serif' font-weight='800' font-size='18' fill='%232762EA' text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <div class="marca"><b>Si<span>fer</span></b>${selector}</div>
    <nav class="nav">
      <a href="/${cliente.id}/resumen" class="${activo === 'resumen' ? 'on' : ''}">Resumen</a>
      <a href="/${cliente.id}/leads" class="${activo === 'leads' ? 'on' : ''}">Leads</a>
      ${rol === 'admin' ? `<a href="/${cliente.id}/salud" class="${activo === 'salud' ? 'on' : ''}" title="Solo Sifer">Salud del agente</a>` : ''}
    </nav>
  </div>
</header>
<div class="barra">${barra}<span class="actualizado" id="frescura">Último mensaje recibido ${esc(tiempoRelativo(ultimoDato))} · <span id="revisado">actualizado recién</span></span></div>
<main>${contenido}</main>
<script>
  // Polling cada 60 s: trae la misma URL y reemplaza el contenido sin recargar
  // (no pierde el scroll). Se pausa mientras hay un formulario en uso o un panel
  // abierto, y al volver a la pestaña (en el celular los timers se congelan en
  // segundo plano) se actualiza en el momento si pasó más de 1 minuto.
  (function(){
    var REFRESCAR = ${refrescar ? 'true' : 'false'};
    var ultimo = Date.now();
    function ocupado(){
      var a = document.activeElement;
      return document.querySelector('.drawer') || document.querySelector('details[open]') || (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName));
    }
    function pintarRevisado(){
      var s = Math.round((Date.now() - ultimo) / 1000);
      var el = document.getElementById('revisado');
      if (el) el.textContent = s < 10 ? 'actualizado recién' : 'actualizado hace ' + (s < 60 ? s + ' s' : Math.floor(s / 60) + ' min');
    }
    function refrescar(){
      if (!REFRESCAR || ocupado()) return;
      fetch(location.href, { credentials: 'same-origin', cache: 'no-store' })
        .then(function(r){ if (!r.ok) throw r.status; return r.text(); })
        .then(function(html){
          var doc = new DOMParser().parseFromString(html, 'text/html');
          if (ocupado()) return;
          // Conserva el scroll de las columnas del kanban
          var scrolls = {};
          document.querySelectorAll('[data-scroll]').forEach(function(el){ scrolls[el.dataset.scroll] = el.scrollTop; });
          document.querySelector('main').innerHTML = doc.querySelector('main').innerHTML;
          document.querySelectorAll('[data-scroll]').forEach(function(el){ if (scrolls[el.dataset.scroll]) el.scrollTop = scrolls[el.dataset.scroll]; });
          document.getElementById('frescura').innerHTML = doc.getElementById('frescura').innerHTML;
          ultimo = Date.now(); pintarRevisado();
        })
        .catch(function(){ var el = document.getElementById('revisado'); if (el) el.textContent = 'sin conexión, reintentando'; });
    }
    setInterval(refrescar, 60000);
    setInterval(pintarRevisado, 5000);
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'visible' && Date.now() - ultimo > 60000) refrescar();
    });
  })();
</script>
</body>
</html>`;
}

module.exports = { esc, qs, numero, layout, selectorPeriodo };
