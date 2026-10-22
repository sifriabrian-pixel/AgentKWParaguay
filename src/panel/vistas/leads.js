// Vista "Leads": kanban / lista filtrable + drawer del lead.
// Copia de sifer-panel-v2/src/vistas/leads.js; los cambios para KW están marcados con "KW:".

const { esc, qs, layout, selectorPeriodo } = require('../html');
const { tiempoRelativo, duracionCorta } = require('../tiempo');
const { OPERACIONES, OFICINA_ID, asesoresActivos, esPersona } = require('../datos');
const metricas = require('../metricas');

const POR_PAGINA = 25;
const MAX_POR_COLUMNA = 150;

// Columnas del kanban (sin drag & drop: la etapa la definen el agente y las marcas).
const COLUMNAS = [
  { id: 'conversando', label: 'Conversando', etapas: ['nuevo'] },
  { id: 'calificado', label: 'Calificado', etapas: ['calificado'] },
  { id: 'derivado', label: 'Derivado', etapas: ['derivado'] },
  // TODO: Reactivar la columna "Contactado" cuando se implemente el loop de
  // confirmación por WhatsApp (hoy la marca manual no es confiable).
  { id: 'descartado', label: 'Descartado', etapas: ['descartado', 'fuera'] },
];

const MARCAS = [
  ['urgente', '🔴 Urgente', 'rojo'],
  ['atendido', '✅ Asesor contactó', 'verde'],
  ['asignado', '🔵 Asignado', 'violeta'],
  ['descartado', '⚪ Descartado', ''],
];

const ETIQUETA_EVENTO = {
  lead_atendido: 'Escribió por primera vez',
  origen_campania: 'Llegó desde un anuncio de Meta',
  flujo_propietario: 'Clasificado: propietario',
  flujo_asesor: 'Clasificado: quiere ser asesor',
  flujo_comprador: 'Clasificado: comprador',
  flujo_arrendatario: 'Clasificado: arrendatario',
  handoff_propietario: 'Derivado (propietario)',
  handoff_asesor: 'Derivado (postulante a asesor)',
  handoff_comprador: 'Derivado (comprador)',
  handoff_arrendatario: 'Derivado (arrendatario)',
  handoff_general: 'Derivado (consulta general)',
  handoff_hablar_asesor: 'Derivado (pidió hablar con un asesor)',
  handoff_pautada: 'Derivado (propiedad pautada)',
  handoff_imbabura: 'Derivado (Imbabura)',
  fuera_horario: 'Derivado fuera de horario',
  fuera_cobertura: 'Fuera de cobertura',
  seguimiento_30min: 'Seguimiento automático (30 min)',
  seguimiento_24h: 'Seguimiento automático (24 h)',
  seguimiento_72h: 'Seguimiento automático (72 h)',
  agenda_entrevista: 'Entrevista de reclutamiento agendada (derivado)',
  reactivado: 'Respondió al seguimiento',
  marked_urgent: 'Marcado 🔴 Urgente',
  marked_attended: 'Marcado ✅ Asesor contactó',
  advisor_changed: 'Cambio de asesor',
  reassigned: 'Reasignado',
  marked_assigned: 'Marcado 🔵 Asignado',
  marked_discarded: 'Marcado ⚪ Descartado',
  mark_removed: 'Se quitó la marca',
  note_added: 'Nota interna',
  // KW: eventos propios de este agente.
  created: 'Escribió por primera vez',
  referral_captured: 'Llegó desde un anuncio de Meta',
  campaign_resolved: 'Se identificó la campaña del anuncio',
  flow_changed: 'Cambió el tipo de consulta',
  flow_opened: 'Abrió una segunda consulta',
  propiedad_consultada: 'Consultó por una propiedad del catálogo',
  derived: 'Derivado al asesor',
  derivation_failed: 'No se pudo derivar: no hay nadie configurado',
  advisor_notified: 'Se le avisó al asesor por WhatsApp',
  advisor_notify_failed: 'No se pudo avisar al asesor por WhatsApp',
  document_forwarded: 'Su documento se reenvió al responsable',
  document_not_forwarded: 'Mandó un documento (no se reenvió)',
  document_forward_failed: 'No se pudo reenviar su documento',
  send_failed: 'Un mensaje del agente no se pudo enviar',
};

// KW: eventos técnicos que no aportan en la historia del lead.
const EVENTOS_OCULTOS = new Set(['llm_tag', 'llm_error', 'llm_refusal', 'propiedades_buscadas', 'handoff_blocked', 'campaign_parse_failed', 'referral_repeat', 'conversation_reset']);

function tagEtapa(l) {
  const e = metricas.etapa(l);
  const clase = { derivado: 'azul', descartado: '', fuera: '', calificado: 'azul', nuevo: '' }[e];
  return `<span class="tag ${clase}">${metricas.ETAPAS[e]}</span>`;
}

function tagMarca(l) {
  const m = MARCAS.find(([v]) => v === l.prioridad);
  return m ? `<span class="tag ${m[2]}">${m[1]}</span>` : '';
}

// ── Filtros (del lado del servidor) ──────────────────────────────────────

function leerFiltros(params) {
  const f = {};
  for (const k of ['q', 'etapa', 'operacion', 'zona', 'asesor', 'marca', 'anuncio', 'preset']) f[k] = (params.get(k) || '').trim();
  f.vista = params.get('vista') === 'lista' ? 'lista' : 'kanban';
  f.pagina = Math.max(1, parseInt(params.get('pagina') || '1', 10) || 1);
  return f;
}

// Período: por última actividad del lead. La cola "Necesitan atención" es en
// vivo y no depende del período.
function filtrar(modelo, f, periodo) {
  let filas;
  if (f.preset === 'atencion') {
    filas = metricas.colaAtencion(modelo).map((it) => ({ lead: it.lead, motivo: it.motivo, esperaMs: it.esperaMs }));
  } else {
    filas = modelo.leads
      .filter((l) => { const t = new Date(l.ultimoMensaje).getTime(); return !periodo || (t >= periodo.from && t < periodo.to); })
      .sort((a, b) => String(b.ultimoMensaje).localeCompare(String(a.ultimoMensaje)))
      .map((lead) => ({ lead }));
  }
  const q = f.q.toLowerCase();
  return filas.filter(({ lead: l }) =>
    (!q || l.nombre.toLowerCase().includes(q) || l.numero.includes(q.replace(/\D/g, '') || '§'))
    && (!f.etapa || metricas.etapa(l) === f.etapa)
    && (!f.operacion || l.operacion === f.operacion)
    && (!f.zona || l.zona === f.zona)
    && (!f.asesor || metricas.nombreAsesor(l) === f.asesor)
    && (!f.marca || (f.marca === 'ninguna' ? !l.prioridad : l.prioridad === f.marca))
    && (!f.anuncio || (f.anuncio === 'con' ? !!l.origen : f.anuncio === 'sin' ? !l.origen : tituloAnuncio(l) === f.anuncio)));
}

function select(nombre, valor, opciones, placeholder) {
  return `<select name="${nombre}" aria-label="${esc(placeholder)}">
    <option value="">${esc(placeholder)}</option>
    ${opciones.map(([v, label]) => `<option value="${esc(v)}" ${v === valor ? 'selected' : ''}>${esc(label)}</option>`).join('')}
  </select>`;
}

// Título del anuncio de Meta del que vino el lead (como lo muestra el panel activo).
function tituloAnuncio(l) {
  return l.origen ? (l.origen.titulo || l.origen.url || 'Anuncio sin título') : null;
}

function formFiltros(cliente, modelo, f, periodoParams) {
  const anuncios = [...new Set(modelo.leads.map(tituloAnuncio).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const asesores = [...new Set(modelo.leads.filter((l) => l.derivado).map(metricas.nombreAsesor))].sort();
  return `<form class="filtros" method="GET" action="/${cliente.id}/leads">
    ${f.preset ? `<input type="hidden" name="preset" value="${esc(f.preset)}">` : ''}
    ${f.vista === 'lista' ? '<input type="hidden" name="vista" value="lista">' : ''}
    ${Object.entries(periodoParams).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')}
    <input type="search" name="q" value="${esc(f.q)}" placeholder="Buscar nombre o número">
    ${select('etapa', f.etapa, Object.entries(metricas.ETAPAS), 'Etapa')}
    ${select('operacion', f.operacion, OPERACIONES.map((o) => [o, o]), 'Qué busca')}
    ${select('zona', f.zona, cliente.zonas.map((z) => [z, z]), 'Zona')}
    ${select('asesor', f.asesor, asesores.map((a) => [a, a]), 'Asesor')}
    ${select('marca', f.marca, [...MARCAS.map(([v, l]) => [v, l]), ['ninguna', 'Sin marca']], 'Marca')}
    ${select('anuncio', f.anuncio, [['con', 'Vino de un anuncio (todos)'], ...anuncios.map((a) => [a, `📣 ${a}`]), ['sin', 'Sin anuncio']], 'Origen')}
    <button class="btn" type="submit">Filtrar</button>
  </form>`;
}

// ── Drawer ───────────────────────────────────────────────────────────────

function renderChat(historial, tz) {
  let diaAnterior = null;
  return historial.map((m) => {
    const fecha = m.ts ? new Date(m.ts) : null;
    let sep = '';
    if (fecha) {
      const dia = fecha.toLocaleDateString('es-EC', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' });
      if (dia !== diaAnterior) { sep = `<div class="sep-fecha"><span>${esc(dia)}</span></div>`; diaAnterior = dia; }
    }
    const hora = fecha ? fecha.toLocaleTimeString('es-EC', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) : '';
    const estado = m.role === 'assistant' ? { leido: ' ✓✓ leído', entregado: ' ✓✓', enviado: ' ✓', fallido: ' ⚠ no enviado' }[m.estadoEnvio] || '' : '';
    return `${sep}<div class="burbuja ${m.role === 'user' ? 'u' : 'a'}">${esc(m.content)}<small>${hora}${estado}</small></div>`;
  }).join('');
}

// Desplegable de asesor: guarda al cambiar (fetch) y muestra "Guardado".
// Sin JavaScript, el botón de <noscript> hace el mismo POST con redirección.
// El desplegable muestra el destino real de la derivación, incluida "Oficina".
// "Sin asesor asignado" solo existe como opción si el lead no está derivado.
// Al lado: "Asignado automáticamente" (lo derivó el agente) o
// "Reasignado por {usuario}" (último cambio hecho desde el panel).
function selectorAsesor(cliente, l, asesores, volver) {
  const destino = metricas.nombreAsesor(l);
  const esOficina = l.asesorId === OFICINA_ID || destino === metricas.OFICINA;
  const actual = esOficina ? null
    : asesores.find((a) => a.id === l.asesorId)
      || asesores.find((a) => a.nombre.toLowerCase() === String(l.asesor || '').trim().toLowerCase());
  // Asesor que no está en la lista activa, o derivación sin destino registrado.
  const otro = esOficina || actual || destino === metricas.SIN_ASESOR ? null
    : destino === metricas.DESTINO_NO_REGISTRADO ? 'Derivado · destino no registrado'
    : `${destino} (no está en la lista)`;

  const reasignacion = [...l.eventos].reverse().find((e) => e.tipo === 'reassigned' || e.tipo === 'advisor_changed');
  const origen = reasignacion ? `Reasignado por ${reasignacion.usuario || 'el panel'}`
    : l.derivado ? `Asignado automáticamente${l.asesorInferido ? ` · según ${l.asesorInferido}` : ''}` : '';

  return `<form class="form-asesor" method="POST" action="/${cliente.id}/asesor">
    <input type="hidden" name="numero" value="${esc(l.numero)}">
    <input type="hidden" name="volver" value="${esc(volver)}">
    <select class="sel" id="asesor" name="asesor" aria-label="Asesor asignado">
      ${!l.derivado ? `<option value="" ${!esOficina && !actual && !otro ? 'selected' : ''}>${metricas.SIN_ASESOR}</option>` : ''}
      ${otro ? `<option value="" selected disabled>${esc(otro)}</option>` : ''}
      <option value="${OFICINA_ID}" ${esOficina ? 'selected' : ''}>${metricas.OFICINA}</option>
      ${asesores.map((a) => `<option value="${esc(a.id)}" ${actual && actual.id === a.id ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}
    </select>
    ${origen ? `<span class="item-s origen-asesor">${esc(origen)}</span>` : ''}
    <span class="guardado" role="status" aria-live="polite"></span>
    <noscript><button class="btn sec" type="submit">Guardar</button></noscript>
  </form>
  <script>
    (function () {
      var form = document.currentScript.previousElementSibling;
      var aviso = form.querySelector('.guardado');
      var timer;
      form.querySelector('select').addEventListener('change', function () {
        aviso.textContent = 'Guardando…';
        fetch(form.action, {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)).toString(),
          credentials: 'same-origin',
        }).then(function (r) {
          if (!r.ok) throw r.status;
          return r.json();
        }).then(function (res) {
          aviso.textContent = 'Guardado ✓';
          var origen = form.querySelector('.origen-asesor');
          if (!origen) {
            origen = document.createElement('span');
            origen.className = 'item-s origen-asesor';
            aviso.parentNode.insertBefore(origen, aviso);
          }
          origen.textContent = 'Reasignado por ' + (res.usuario || 'el panel');
        }).catch(function () {
          aviso.textContent = 'No se pudo guardar. Probá de nuevo.';
        }).finally(function () {
          clearTimeout(timer);
          timer = setTimeout(function () { if (aviso.textContent === 'Guardado ✓') aviso.textContent = ''; }, 2500);
        });
      });
    })();
  </script>`;
}

function renderDrawer(cliente, l, volver, asesores, rol) {
  const tz = cliente.timezone;
  const fechaHora = (f) => new Date(f).toLocaleString('es-EC', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  const ocultos = new Set(['handoffListo', 'asesorAsignado', 'fueraCobertura']);
  const datos = Object.entries(l.datos)
    .filter(([k, v]) => !ocultos.has(k) && v != null && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  const timeline = [...l.eventos].reverse().filter((e) => !EVENTOS_OCULTOS.has(e.tipo)).map((e) => `
    <li class="${e.origen === 'panel' ? 'panel' : ''}"><time>${fechaHora(e.fecha)}${e.origen === 'panel' ? ' · panel' : ''}</time>
      ${esc(ETIQUETA_EVENTO[e.tipo] || e.tipo)}${e.texto ? `: “${esc(e.texto)}”` : ''}${e.tipo === 'advisor_changed' || e.tipo === 'reassigned'
        ? `: ${esc(e.from?.nombre || metricas.SIN_ASESOR)} → ${esc(e.to?.nombre || metricas.SIN_ASESOR)}${e.usuario ? ` · por ${esc(e.usuario)}` : ''}` : ''}</li>`).join('');

  const botones = MARCAS.map(([valor, label]) => `
    <button name="prioridad" value="${valor}" class="${l.prioridad === valor ? 'on' : ''}">${label}</button>`).join('');

  return `<a class="velo" href="${esc(volver)}" aria-label="Cerrar"></a>
  <aside class="drawer" role="dialog" aria-label="Lead ${esc(l.nombre || l.numero)}">
    <div class="d-cab">
      <div>
        <h2>${esc(l.nombre || 'Sin nombre')}</h2>
        <div class="item-s"><a href="https://wa.me/${esc(l.numero)}" target="_blank" rel="noopener">+${esc(l.numero)}</a> · ${esc(l.operacion)} · ${esc(l.zona)}</div>
        <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">${tagEtapa(l)} ${tagMarca(l)}</div>
      </div>
      <a class="d-cerrar" href="${esc(volver)}" aria-label="Cerrar">×</a>
    </div>
    <div class="d-cuerpo">
      ${l.origen ? `<div class="aviso">📣 Vino de un ${l.origen.fuente === 'post' ? 'post' : 'anuncio'} de Meta${l.origen.titulo ? `: “${esc(l.origen.titulo)}”` : ''}
        ${l.origen.url ? ` · <a href="${esc(l.origen.url)}" target="_blank" rel="noopener">ver ↗</a>` : ''}</div>` : ''}
      ${l.notaAutomatica ? `<div class="aviso violeta">${esc(l.notaAutomatica)}</div>` : ''}

      <div class="d-sec">
        <h3>Seguimiento</h3>
        <dl class="datos">
          <dt>Asesor</dt><dd>${selectorAsesor(cliente, l, asesores, volver)}</dd>
          <dt>Derivado</dt><dd>${l.derivadoEn ? `${fechaHora(l.derivadoEn)} (${tiempoRelativo(l.derivadoEn)})` : 'No'}</dd>
          <dt>Calificado</dt><dd>${l.calificado ? `Sí · ${esc(l.motivoCalificacion)}` : 'No'}${rol === 'admin' ? ` ${badgeEspera(l, Date.now())}` : ''}</dd>
          <dt>Última actividad</dt><dd>${tiempoRelativo(l.ultimoMensaje)}</dd>
        </dl>
        <form method="POST" action="/${cliente.id}/marcar" style="margin-top:10px">
          <input type="hidden" name="numero" value="${esc(l.numero)}">
          <input type="hidden" name="volver" value="${esc(volver)}">
          <div class="marcas">${botones}${l.prioridad ? '<button name="prioridad" value="">Quitar</button>' : ''}</div>
        </form>
        <form class="nota" method="POST" action="/${cliente.id}/nota" style="margin-top:10px">
          <input type="hidden" name="numero" value="${esc(l.numero)}">
          <input type="hidden" name="volver" value="${esc(volver)}">
          <label class="kpi-l" for="nota">📝 Nota interna</label>
          <textarea id="nota" name="nota" placeholder="Ej: en seguimiento, no contesta…">${esc(l.nota)}</textarea>
          <button class="btn" type="submit" style="margin-top:6px">Guardar nota</button>
        </form>
      </div>

      ${datos ? `<div class="d-sec"><h3>Datos capturados</h3><dl class="datos">${datos}</dl></div>` : ''}
      <div class="d-sec"><h3>Historia</h3>${timeline ? `<ul class="timeline">${timeline}</ul>` : '<p class="vacio">Sin eventos registrados.</p>'}</div>
      <div class="d-sec"><h3>Conversación</h3><div class="chat">${renderChat(l.historial, tz)}</div></div>
    </div>
  </aside>`;
}

// ── Página ───────────────────────────────────────────────────────────────

// Alerta de Salud del agente (solo admin): calificado hace más de 15 min sin derivar.
function badgeEspera(l, ahora) {
  if (!metricas.calificadoSinDerivar(l, ahora)) return '';
  return `<span class="tag rojo" title="Calificado sin derivar">Sin derivar · ${duracionCorta(ahora - new Date(l.calificadoEn).getTime())}</span>`;
}

function renderKanban(filas, urlCon, rol) {
  const ahora = Date.now();
  const porColumna = new Map(COLUMNAS.map((c) => [c.id, []]));
  for (const fila of filas) {
    const e = metricas.etapa(fila.lead, ahora);
    const col = COLUMNAS.find((c) => c.etapas.includes(e));
    if (col) porColumna.get(col.id).push(fila);
  }

  const columnas = COLUMNAS.map((col) => {
    const items = porColumna.get(col.id);
    const tarjetas = items.slice(0, MAX_POR_COLUMNA).map(({ lead: l }) => {
      const detalle = [l.operacion, l.zona !== 'Sin especificar' ? l.zona : null].filter(Boolean).join(' · ');
      const asesor = l.derivado || esPersona(l.asesor) ? metricas.nombreAsesor(l) : null;
      return `<a class="kb-card" href="${esc(urlCon({ numero: l.numero }))}">
        <div class="kb-t"><span>${esc(l.nombre || '+' + l.numero)}</span><small>${tiempoRelativo(l.ultimoMensaje)}</small></div>
        <div class="kb-s">${esc(detalle)}</div>
        ${asesor ? `<div class="kb-s">👤 ${esc(asesor)}</div>` : ''}
        ${l.origen ? `<div class="kb-s kb-anuncio" title="Vino de un anuncio de Meta">📣 ${esc(tituloAnuncio(l))}</div>` : ''}
        <div class="kb-tags">${rol === 'admin' ? badgeEspera(l, ahora) : ''}${tagMarca(l)}${l.fueraCobertura && !l.derivado ? '<span class="tag">Fuera de cobertura</span>' : ''}${l.nota ? `<span class="tag" title="${esc(l.nota)}">📝</span>` : ''}</div>
      </a>`;
    }).join('');
    const resto = items.length - MAX_POR_COLUMNA;
    return `<section class="kb-col" aria-label="${col.label}">
      <div class="kb-cab">${col.label}<span>${items.length}</span></div>
      <div class="kb-body" data-scroll="${col.id}">
        ${tarjetas || '<p class="vacio">Sin leads.</p>'}
        ${resto > 0 ? `<p class="vacio">Y ${resto} más. Usá la vista Lista o los filtros.</p>` : ''}
      </div>
    </section>`;
  }).join('');
  return `<div class="kb">${columnas}</div>`;
}

function renderLista(filas, pagina, urlCon, esAtencion) {
  const paginas = Math.max(1, Math.ceil(filas.length / POR_PAGINA));
  const visibles = filas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
  const trs = visibles.map(({ lead: l, motivo, esperaMs }) => {
    const href = urlCon({ numero: l.numero });
    return `<tr class="click" onclick="location.href='${esc(href)}'">
      <td class="prim" data-l="Lead"><a href="${esc(href)}">${esc(l.nombre || '+' + l.numero)}</a>${l.nombre ? `<div class="item-s">+${esc(l.numero)}</div>` : ''}</td>
      ${esAtencion ? `<td data-l="Motivo"><span class="tag rojo">${esc(motivo)}</span></td><td class="n" data-l="Espera">${duracionCorta(esperaMs)}</td>` : ''}
      <td data-l="Qué busca">${esc(l.operacion)}</td>
      <td data-l="Zona">${esc(l.zona)}${l.origen ? `<div class="item-s" title="Vino de un anuncio de Meta">📣 ${esc(tituloAnuncio(l))}</div>` : ''}</td>
      <td data-l="Etapa">${tagEtapa(l)}</td>
      <td data-l="Asesor">${esc(l.derivado || esPersona(l.asesor) ? metricas.nombreAsesor(l) : '—')}</td>
      <td data-l="Marca">${tagMarca(l) || '—'}${l.nota ? ' <span title="' + esc(l.nota) + '">📝</span>' : ''}</td>
      <td class="n" data-l="Última actividad">${tiempoRelativo(l.ultimoMensaje)}</td>
    </tr>`;
  }).join('');

  return `<div class="card" style="padding:6px 8px">
      ${trs ? `<table class="t"><thead><tr>
        <th>Lead</th>${esAtencion ? '<th>Motivo</th><th class="n">Espera</th>' : ''}<th>Qué busca</th><th>Zona</th><th>Etapa</th><th>Asesor</th><th>Marca</th><th class="n">Última actividad</th>
      </tr></thead><tbody>${trs}</tbody></table>` : `<p class="vacio">${esAtencion ? 'No hay leads pendientes. 🎉' : 'Ningún lead coincide con estos filtros.'}</p>`}
    </div>
    ${paginas > 1 ? `<div class="paginas">
      ${pagina > 1 ? `<a class="btn sec" href="${esc(urlCon({ pagina: pagina - 1 }))}">← Anterior</a>` : '<span></span>'}
      <span>Página ${pagina} de ${paginas}</span>
      ${pagina < paginas ? `<a class="btn sec" href="${esc(urlCon({ pagina: pagina + 1 }))}">Siguiente →</a>` : '<span></span>'}
    </div>` : ''}`;
}

function renderLeads({ cliente, clientesDisponibles, modelo, params, periodo, rol }) {
  const f = leerFiltros(params);
  const esAtencion = f.preset === 'atencion';
  const filas = filtrar(modelo, f, periodo);
  const paginas = Math.max(1, Math.ceil(filas.length / POR_PAGINA));
  const pagina = f.vista === 'lista' ? Math.min(f.pagina, paginas) : 1;

  const periodoParams = periodo.preset === '30' ? {} : periodo.preset === 'custom'
    ? { p: 'custom', desde: periodo.desde, hasta: periodo.hasta } : { p: periodo.preset };
  const filtros = { q: f.q, etapa: f.etapa, operacion: f.operacion, zona: f.zona, asesor: f.asesor, marca: f.marca, anuncio: f.anuncio, preset: f.preset };
  const estado = { ...filtros, vista: f.vista === 'lista' ? 'lista' : '', ...periodoParams };
  const base = `/${cliente.id}/leads`;
  const urlCon = (extra) => base + qs({ ...estado, pagina: pagina > 1 ? pagina : '', ...extra });

  const numeroAbierto = params.get('numero');
  const leadAbierto = numeroAbierto ? modelo.porNumero.get(numeroAbierto) : null;
  const hayFiltros = Object.values(filtros).some(Boolean);

  const toggle = `<div class="chips" role="group" aria-label="Vista">
    <a class="chip ${f.vista === 'kanban' ? 'on' : ''}" href="${esc(base + qs({ ...estado, vista: '' }))}">Kanban</a>
    <a class="chip ${f.vista === 'lista' ? 'on' : ''}" href="${esc(base + qs({ ...estado, vista: 'lista' }))}">Lista</a>
  </div>`;

  const contenido = `
    <div class="card">
      ${formFiltros(cliente, modelo, f, periodoParams)}
      <div class="paginas" style="margin-top:8px;gap:8px;flex-wrap:wrap">
        <span>${filas.length} leads${esAtencion ? ' que necesitan atención (en vivo, no depende del período)' : ` con actividad en: ${esc(periodo.etiqueta.toLowerCase())}`}${hayFiltros ? ` · <a href="${base}">limpiar filtros</a>` : ''}</span>
        <span style="display:flex;gap:8px;align-items:center">${toggle}<a class="btn sec" href="/${cliente.id}/leads.csv${qs({ ...filtros, ...periodoParams })}">⬇ CSV</a></span>
      </div>
    </div>
    <div style="margin-top:12px">
      ${f.vista === 'lista' ? renderLista(filas, pagina, urlCon, esAtencion) : renderKanban(filas, urlCon, rol)}
    </div>
    ${leadAbierto ? renderDrawer(cliente, leadAbierto, urlCon({}), asesoresActivos(cliente.id), rol) : ''}`;

  const presets = `<div class="chips">
    <a class="chip ${!esAtencion ? 'on' : ''}" href="${esc(base + qs({ vista: estado.vista, ...periodoParams }))}">Todos</a>
    <a class="chip ${esAtencion ? 'on' : ''}" href="${esc(base + qs({ preset: 'atencion', vista: estado.vista }))}">Necesitan atención</a>
  </div>
  ${esAtencion ? '' : selectorPeriodo(base, periodo, { ...filtros, vista: estado.vista })}`;

  return layout({
    cliente, clientesDisponibles, activo: 'leads', titulo: 'Leads', barra: presets, rol,
    contenido, ultimoDato: modelo.ultimoDato, refrescar: !leadAbierto,
  });
}

// Marca para el CSV: el mismo nombre que en pantalla, sin el ícono.
function etiquetaMarca(valor) {
  const m = MARCAS.find(([v]) => v === valor);
  return m ? m[1].replace(/^\S+\s/, '') : '';
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function generarCsv(cliente, modelo, params, periodo) {
  const filas = filtrar(modelo, leerFiltros(params), periodo);
  const cab = ['Nombre', 'Numero', 'Que busca', 'Zona', 'Sector', 'Presupuesto', 'Etapa', 'Asesor', 'Marca', 'Anuncio de origen', 'Nota', 'Primer mensaje', 'Ultimo mensaje'];
  const fecha = (f) => (f ? new Date(f).toLocaleString('es-EC', { timeZone: cliente.timezone }) : '');
  const lineas = filas.map(({ lead: l }) => [
    l.nombre, l.numero, l.operacion, l.zona, l.datos.sector || l.datos.zona || '', l.datos.presupuesto || l.datos.precio || '',
    metricas.ETAPAS[metricas.etapa(l)], l.derivado || esPersona(l.asesor) ? metricas.nombreAsesor(l) : '', etiquetaMarca(l.prioridad),
    l.origen?.titulo || l.origen?.url || '', l.nota, fecha(l.creadoEn), fecha(l.ultimoMensaje),
  ].map(csvEscape).join(','));
  return '﻿' + [cab.join(','), ...lineas].join('\n');
}

module.exports = { renderLeads, generarCsv };
