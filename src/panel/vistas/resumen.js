// Home "Resumen": lo que un líder tiene que entender en 10 segundos.

const { esc, qs, numero, layout, selectorPeriodo } = require('../html');
const { duracionCorta, fechaCorta } = require('../tiempo');
const metricas = require('../metricas');

const COLOR_ATENDIDOS = '#2762EA';
const COLOR_DERIVADOS = '#E08A1E';

// Variación contra el período anterior. `pp` = la métrica ya es un %, se
// compara en puntos porcentuales. `menosEsMejor` invierte el color.
function delta(actual, anterior, { pp = false, menosEsMejor = false, neutro = false } = {}) {
  if (actual == null || anterior == null) return '';
  let txt, diff;
  if (pp) {
    diff = actual - anterior;
    txt = `${diff > 0 ? '+' : ''}${diff} pp`;
  } else {
    if (anterior === 0) return actual > 0 ? '<span class="delta igual" title="Sin datos en el período anterior">nuevo</span>' : '';
    diff = Math.round(((actual - anterior) / anterior) * 100);
    txt = `${diff > 0 ? '▲' : diff < 0 ? '▼' : ''} ${Math.abs(diff)}%`;
  }
  const clase = diff === 0 || neutro ? 'igual' : (diff > 0) !== menosEsMejor ? 'bien' : 'mal';
  return `<span class="delta ${clase}" title="vs. período anterior (${anterior}${pp ? '%' : ''})">${txt.trim()}</span>`;
}

function kpi({ label, valor, sub = '', clase = '', href }) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi ${clase}" ${href ? `href="${href}"` : ''}>
    <div class="kpi-l">${label}</div>
    <div class="kpi-v tabnum">${valor}</div>
    <div class="kpi-s">${sub}</div>
  </${tag}>`;
}

// Vista del cliente. "Clasificados" y "Calificados sin derivar" no están acá:
// son internas de Sifer (Salud del agente). Los % se calculan sobre atendidos.
const pctDe = (n, total) => (total > 0 ? Math.round((n / total) * 100) : null);

// Dos circuitos: clientes (propiedades) y postulantes a asesor (reclutamiento).
// Derivaciones = total de ambos. Los % se calculan sobre Leads atendidos.
function seccionKpis(p) {
  const a = p.actual, b = p.anterior;
  const pctCli = pctDe(a.clientes.calificados, a.atendidos), pctCliAnt = pctDe(b.clientes.calificados, b.atendidos);
  const pctPos = pctDe(a.postulantes.calificados, a.atendidos), pctPosAnt = pctDe(b.postulantes.calificados, b.atendidos);
  return `<section class="kpis" aria-label="Indicadores">
    ${kpi({ label: 'Leads atendidos', valor: numero(a.atendidos), sub: delta(a.atendidos, b.atendidos) })}
    ${kpi({ label: 'Clientes calificados', valor: numero(a.clientes.calificados), sub: `${pctCli ?? '—'}% de los atendidos ${delta(pctCli, pctCliAnt, { pp: true })}` })}
    ${kpi({ label: 'Asesores calificados', valor: numero(a.postulantes.calificados), sub: `${pctPos ?? '—'}% de los atendidos ${delta(pctPos, pctPosAnt, { pp: true })}` })}
    ${kpi({ label: 'Derivaciones', valor: numero(a.derivados), sub: `${numero(a.clientes.derivados)} clientes · ${numero(a.postulantes.derivados)} asesores ${delta(a.derivados, b.derivados)}` })}
  </section>`;
}

// Un embudo por circuito: leads → calificados → derivados. La última etapa
// cuenta los calificados que se derivaron; si además se derivaron leads que
// no califican, se informan aparte para que la conversión no pase del 100%.
function embudo(titulo, etiquetas, c) {
  const pasos = [[etiquetas[0], c.leads], [etiquetas[1], c.calificados], ['Derivados', c.calificadosDerivados]];
  const max = Math.max(c.leads, 1);
  const conv = (i) => (pasos[i - 1][1] > 0 ? `${Math.round((pasos[i][1] / pasos[i - 1][1]) * 100)}%` : '—');
  const otros = c.derivados - c.calificadosDerivados;

  const mobile = pasos.map(([label, n], i) => `
    ${i > 0 ? `<div class="f-conv">↓ ${conv(i)} pasa</div>` : ''}
    <div class="f-fila"><span>${label}</span><div class="f-bar"><i style="width:${Math.max((n / max) * 100, n ? 1 : 0)}%"></i></div><b class="tabnum">${numero(n)}</b></div>`).join('');

  const desktop = pasos.map(([label, n], i) => `
    ${i > 0 ? `<div class="f-flecha"><span>→</span><b>${conv(i)}</b></div>` : ''}
    <div class="f-paso"><div class="f-n tabnum">${numero(n)}</div><div class="kpi-l">${label}</div>
      <div class="f-bar" style="margin-top:8px"><i style="width:${Math.max((n / max) * 100, n ? 1 : 0)}%"></i></div></div>`).join('');

  return `<div class="sub-h">${titulo}</div>
      <div class="funnel solo-mobile">${mobile}</div>
      <div class="funnel solo-desktop">${desktop}</div>
      ${otros > 0 ? `<p class="vacio" style="padding:6px 0 0">Además se derivaron ${numero(otros)} ${otros === 1 ? 'lead que no cumple' : 'leads que no cumplen'} el criterio de calificado.</p>` : ''}`;
}

function seccionFunnel(a) {
  const reclutamiento = a.postulantes.leads > 0
    ? `<div style="border-top:1px solid var(--line-2);margin-top:14px;padding-top:4px">${embudo('Reclutamiento', ['Postulantes', 'Asesores calificados'], a.postulantes)}</div>` : '';
  return `<section class="seccion">
    <div class="seccion-cab"><h2>Embudo</h2><small>De los leads que entraron en el período</small></div>
    <div class="card">
      ${embudo('Clientes', ['Consultas de clientes', 'Clientes calificados'], a.clientes)}
      ${reclutamiento}
    </div>
  </section>
  <style>.solo-desktop{display:none!important}@media(min-width:760px){.solo-desktop{display:flex!important}.solo-mobile{display:none!important}}</style>`;
}

function etiquetaMotivo(item) {
  const clase = item.prioridad <= 2 ? 'rojo' : '';
  return `<span class="tag ${clase}">${esc(item.motivo)}</span>`;
}

function seccionAtencion(cola, clienteId, total) {
  const items = cola.slice(0, 10).map((it) => {
    const l = it.lead;
    const horas = it.esperaMs != null ? duracionCorta(it.esperaMs) : '—';
    const alta = it.esperaMs != null && it.esperaMs > 48 * 3600000;
    return `<li><a class="item" href="/${clienteId}/leads${qs({ preset: 'atencion', numero: l.numero })}">
      <div class="item-main">
        <div class="item-t">${esc(l.nombre || l.numero)}</div>
        <div class="item-s">${etiquetaMotivo(it)} · ${esc(l.operacion)}${l.zona !== 'Sin especificar' ? ` · ${esc(l.zona)}` : ''}</div>
      </div>
      <div class="espera ${alta ? 'alta' : ''}" title="Tiempo de espera">${horas}</div>
    </a></li>`;
  }).join('');

  return `<section class="seccion" id="atencion">
    <div class="seccion-cab"><h2>Requieren atención</h2><small>${total} en total</small></div>
    <div class="card" style="padding:6px 10px">
      ${items ? `<ul class="lista">${items}</ul>` : '<p class="vacio">No hay nada pendiente. Los urgentes y los leads que se enfriaron aparecen acá.</p>'}
      ${total > 10 ? `<a class="ver-todos" href="/${clienteId}/leads?preset=atencion">Ver los ${total} →</a>` : ''}
    </div>
  </section>`;
}

function seccionAsesores(filas) {
  if (!filas.length) {
    return `<section class="seccion"><div class="seccion-cab"><h2>Derivaciones por asesor</h2></div>
      <div class="card"><p class="vacio">No hubo derivaciones de leads que entraron en este período.</p></div></section>`;
  }
  const trs = filas.map((f) => `<tr>
    <td class="prim" data-l="Asesor">${esc(f.nombre)}</td>
    <td class="n" data-l="Derivados">${f.derivados}</td>
    <td class="n" data-l="% del total">${f.porcentaje == null ? '—' : f.porcentaje + '%'}</td>
  </tr>`).join('');
  return `<section class="seccion">
    <div class="seccion-cab"><h2>Derivaciones por asesor</h2><small>Leads que entraron en el período</small></div>
    <div class="card" style="padding:6px 8px">
      <table class="t"><thead><tr><th>Asesor</th><th class="n">Derivados</th><th class="n">% del total</th></tr></thead>
      <tbody>${trs}</tbody></table>
    </div>
  </section>`;
}

function tile(label, valor, sub) {
  return `<div class="tile"><div class="tile-l">${label}</div><div class="tile-v tabnum">${valor}</div><div class="tile-s">${sub}</div></div>`;
}

function seccionValorAgente(a, b, agente) {
  const respuesta = a.respuestaAgenteSeg == null ? '—'
    : a.respuestaAgenteSeg < 60 ? `${Math.round(a.respuestaAgenteSeg)} s` : duracionCorta(a.respuestaAgenteSeg * 1000);
  return `<section class="seccion">
    <div class="seccion-cab"><h2>Valor de ${esc(agente)}</h2><small>Lo que trabajó sin que nadie lo vea</small></div>
    <div class="tiles">
      ${tile('Fuera de horario', numero(a.fueraHorario), `${a.atendidos ? Math.round((a.fueraHorario / a.atendidos) * 100) : 0}% de los leads escribió fuera de horario ${delta(a.fueraHorario, b.fueraHorario, { neutro: true })}`)}
      ${tile('Respuesta (mediana)', respuesta, 'Desde el primer mensaje del lead')}
      ${tile('Reactivados', numero(a.reactivados), `De ${a.conSeguimiento} que recibieron seguimiento`)}
      ${tile('Tasa de lectura', a.tasaLectura == null ? '—' : a.tasaLectura + '%', 'Mensajes del agente leídos')}
    </div>
  </section>`;
}

// ── Gráfico diario (SVG, sin librerías) ──────────────────────────────────

function graficoDiario(serie) {
  const W = 640, H = 190, PL = 30, PR = 8, PT = 10, PB = 24;
  const max = Math.max(1, ...serie.map((d) => d.atendidos));
  const paso = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
  const tope = Math.ceil(max / paso) * paso;
  const y = (v) => PT + (H - PT - PB) * (1 - v / tope);
  const banda = (W - PL - PR) / serie.length;
  const barW = Math.min(12, Math.max(2, (banda - 4) / 2));

  let grid = '';
  for (let v = 0; v <= tope; v += paso) {
    grid += `<line x1="${PL}" x2="${W - PR}" y1="${y(v)}" y2="${y(v)}" stroke="#E4E8EF" stroke-width="1"/>
      <text x="${PL - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="#8A94A6">${v}</text>`;
  }

  // Barra con extremo superior redondeado (4px) y base recta.
  const barra = (x, v, color) => {
    if (!v) return '';
    const top = y(v), base = y(0), r = Math.min(4, barW / 2, base - top);
    return `<path d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base} Z" fill="${color}"/>`;
  };

  const marcas = serie.map((d, i) => {
    const cx = PL + banda * i + banda / 2;
    const x1 = cx - barW - 1, x2 = cx + 1;
    return `<g><title>${fechaCorta(d.dia)}: ${d.atendidos} atendidos · ${d.derivados} derivados</title>
      <rect class="hit" x="${PL + banda * i}" y="${PT}" width="${banda}" height="${H - PT - PB}" fill="transparent"/>
      ${barra(x1, d.atendidos, COLOR_ATENDIDOS)}${barra(x2, d.derivados, COLOR_DERIVADOS)}</g>`;
  }).join('');

  const idxEtiquetas = [...new Set([0, Math.floor((serie.length - 1) / 2), serie.length - 1])];
  const ejeX = idxEtiquetas.map((i) => {
    const cx = PL + banda * i + banda / 2;
    const anchor = i === 0 ? 'start' : i === serie.length - 1 ? 'end' : 'middle';
    const x = i === 0 ? PL : i === serie.length - 1 ? W - PR : cx;
    return `<text x="${x}" y="${H - 6}" text-anchor="${anchor}" font-size="10" fill="#8A94A6">${fechaCorta(serie[i].dia).slice(0, 5)}</text>`;
  }).join('');

  const tabla = serie.map((d) => `<tr><td data-l="Día">${fechaCorta(d.dia)}</td><td class="n" data-l="Atendidos">${d.atendidos}</td><td class="n" data-l="Derivados">${d.derivados}</td></tr>`).join('');

  return `<div class="chart">
    <div class="leyenda"><span><i style="background:${COLOR_ATENDIDOS}"></i>Atendidos</span><span><i style="background:${COLOR_DERIVADOS}"></i>Derivados</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Leads atendidos y derivados por día">${grid}${marcas}${ejeX}</svg>
    <details class="tabla"><summary>Ver como tabla</summary>
      <table class="t" style="margin-top:6px"><thead><tr><th>Día</th><th class="n">Atendidos</th><th class="n">Derivados</th></tr></thead><tbody>${tabla}</tbody></table>
    </details>
  </div>`;
}

function barras(filas) {
  const max = Math.max(1, ...filas.map((f) => f.cantidad));
  const total = filas.reduce((s, f) => s + f.cantidad, 0);
  if (!total) return '<p class="vacio">Sin datos en el período.</p>';
  return `<div class="barras">${filas.map((f) => {
    const gris = /sin (especificar|clasificar)|sin definir/i.test(f.nombre);
    return `<div class="b-fila ${gris ? 'gris' : ''}" title="${esc(f.nombre)}: ${f.cantidad} (${Math.round((f.cantidad / total) * 100)}%)">
      <span>${esc(f.nombre)}</span><div class="b-bar"><i style="width:${(f.cantidad / max) * 100}%"></i></div><b>${f.cantidad}</b></div>`;
  }).join('')}</div>`;
}

function seccionDemanda(p, d) {
  const anuncios = d.anuncios.length
    ? `<table class="t"><thead><tr><th>Anuncio</th><th class="n">Leads</th><th class="n">Derivados</th></tr></thead><tbody>
        ${d.anuncios.map((a) => `<tr><td class="prim" data-l="Anuncio">${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.nombre)} ↗</a>` : esc(a.nombre)}</td>
          <td class="n" data-l="Leads">${a.cantidad}</td><td class="n" data-l="Derivados">${a.derivados}</td></tr>`).join('')}
      </tbody></table>`
    : '<p class="vacio">Ningún lead del período llegó desde un anuncio de Meta.</p>';

  return `<section class="seccion">
    <div class="seccion-cab"><h2>Demanda</h2><small>Qué está pidiendo el mercado</small></div>
    <div class="card">${graficoDiario(p.serie)}</div>
    <div class="grid2" style="margin-top:12px">
      <div class="card"><div class="sub-h">Qué buscan</div>${barras(d.operacion)}
        <div class="sub-h">Tipo de propiedad (compra y alquiler)</div>${barras(d.tipologia)}</div>
      <div class="card"><div class="sub-h">Zona</div>${barras(d.zona)}</div>
    </div>
    <div class="card" style="margin-top:12px;padding:10px 8px">
      <div class="sub-h" style="padding:0 4px">Anuncios que más leads trajeron</div>${anuncios}
    </div>
  </section>`;
}

function renderResumen({ cliente, clientesDisponibles, modelo, periodo, rol }) {
  const p = metricas.resumen(modelo, periodo);
  const cola = metricas.colaAtencion(modelo);
  const filasAsesores = metricas.asesores(modelo, periodo);
  const d = metricas.demanda(modelo, p.cohorte);
  const base = `/${cliente.id}/resumen`;

  const contenido = `
    ${seccionKpis(p)}
    ${seccionFunnel(p.actual)}
    ${seccionAtencion(cola, cliente.id, cola.length)}
    ${seccionAsesores(filasAsesores)}
    ${seccionValorAgente(p.actual, p.anterior, cliente.agente)}
    ${seccionDemanda(p, d)}
    <p class="vacio" style="text-align:center">Período anterior: mismo largo, justo antes</p>`;

  return layout({
    cliente, clientesDisponibles, activo: 'resumen', titulo: 'Resumen', rol,
    barra: selectorPeriodo(base, periodo), contenido, ultimoDato: modelo.ultimoDato,
  });
}

module.exports = { renderResumen };
