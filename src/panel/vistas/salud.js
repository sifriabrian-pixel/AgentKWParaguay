// "Salud del agente": métrica interna de Sifer (solo rol admin; el servidor
// no genera esta página para el cliente). Muestra si el agente deriva a
// todos los leads que califican.

const { esc, qs, numero, layout, selectorPeriodo } = require('../html');
const { duracionCorta, tiempoRelativo } = require('../tiempo');
const metricas = require('../metricas');
const alertas = require('../alertas');

function tile(label, valor, sub, clase = '') {
  return `<div class="tile ${clase}"><div class="tile-l">${label}</div><div class="tile-v tabnum">${valor}</div><div class="tile-s">${sub}</div></div>`;
}

function renderSalud({ cliente, clientesDisponibles, modelo, periodo, rol }) {
  const s = metricas.saludAgente(modelo, periodo);
  const base = `/${cliente.id}/salud`;
  const sinDerivar = s.pendientes.length;
  const estadoAlertas = alertas.estado();

  const filas = s.pendientes.map(({ lead: l, motivo, esperaMs }) => {
    const href = `/${cliente.id}/leads${qs({ numero: l.numero })}`;
    return `<tr class="click" onclick="location.href='${esc(href)}'">
      <td class="prim" data-l="Lead"><a href="${esc(href)}">${esc(l.nombre || '+' + l.numero)}</a>${l.nombre ? `<div class="item-s">+${esc(l.numero)}</div>` : ''}</td>
      <td data-l="Qué busca">${esc(l.operacion)}${l.zona !== 'Sin especificar' ? ` · ${esc(l.zona)}` : ''}</td>
      <td data-l="Por qué calificó">${esc(l.motivoCalificacion)}</td>
      <td data-l="Motivo"><span class="tag rojo">${esc(motivo)}</span></td>
      <td class="n" data-l="Sin derivar hace">${duracionCorta(esperaMs)}</td>
      <td class="n" data-l="Última actividad">${tiempoRelativo(l.ultimoMensaje)}</td>
    </tr>`;
  }).join('');

  const retro = s.retroactivas.map((l) => {
    const href = `/${cliente.id}/leads${qs({ numero: l.numero })}`;
    return `<tr class="click" onclick="location.href='${esc(href)}'">
      <td class="prim" data-l="Lead"><a href="${esc(href)}">${esc(l.nombre || '+' + l.numero)}</a></td>
      <td data-l="Qué busca">${esc(l.operacion)}</td>
      <td data-l="Asesor">${esc(metricas.nombreAsesor(l))}</td>
      <td data-l="Derivación"><span class="tag violeta">Retroactiva</span> ${tiempoRelativo(l.derivadoEn)}</td>
    </tr>`;
  }).join('');

  const contenido = `
    <p class="aviso violeta" style="margin:0 0 12px">Solo Sifer ve esta sección. El cliente ve el embudo en Resumen, pero no esta alerta.</p>
    <section class="tiles" aria-label="Salud del agente">
      ${tile('Clasificados', numero(s.clasificados), `${s.atendidos ? Math.round((s.clasificados / s.atendidos) * 100) : 0}% de ${numero(s.atendidos)} atendidos · el agente detectó qué busca`)}
      ${tile('Calificados', numero(s.calificados), 'Leads que entraron en el período y cumplen el criterio')}
      ${tile('Calificados derivados', numero(s.calificadosDerivados), `Con evento de derivación${s.retroactivas.length ? ` · ${numero(s.retroactivas.length)} ${s.retroactivas.length === 1 ? 'retroactiva' : 'retroactivas'}` : ''}`)}
      ${tile('Calificados sin derivar', numero(sinDerivar), `Más de ${metricas.WATCHDOG_MIN} min sin derivación${s.enMargen ? ` · ${numero(s.enMargen)} más dentro del margen` : ''}`, sinDerivar ? 'alerta' : '')}
    </section>
    <p class="vacio" style="padding:8px 2px 0">
      ${s.consistente
        ? `Control: ${numero(s.calificados)} calificados − ${numero(s.calificadosDerivados)} derivados = ${numero(s.calificados - s.calificadosDerivados)} (${numero(sinDerivar)} sin derivar + ${numero(s.enMargen)} dentro del margen).`
        : '<span class="tag rojo">Error de consistencia: sin derivar &gt; calificados − derivados. Quedó registrado en el log del servidor.</span>'}
    </p>

    <section class="seccion">
      <div class="seccion-cab"><h2>Leads calificados sin derivar</h2><small>Los mismos ${numero(sinDerivar)} que cuenta la tarjeta</small></div>
      <div class="card" style="padding:6px 8px">
        ${filas ? `<table class="t"><thead><tr><th>Lead</th><th>Qué busca</th><th>Por qué calificó</th><th>Motivo</th><th class="n">Sin derivar hace</th><th class="n">Última actividad</th></tr></thead>
          <tbody>${filas}</tbody></table>` : '<p class="vacio">El agente derivó a todos los calificados del período. 🎉</p>'}
      </div>
    </section>

    <section class="seccion">
      <div class="seccion-cab"><h2>Derivaciones retroactivas</h2><small>Cargadas después (backfill); cuentan en el período en que entró el lead</small></div>
      <div class="card" style="padding:6px 8px">
        ${retro ? `<table class="t"><thead><tr><th>Lead</th><th>Qué busca</th><th>Asesor</th><th>Derivación</th></tr></thead><tbody>${retro}</tbody></table>`
          : '<p class="vacio">No hay derivaciones retroactivas en este período.</p>'}
      </div>
    </section>

    <section class="seccion">
      <div class="seccion-cab"><h2>Alertas por email</h2></div>
      <div class="card"><p class="item-s" style="white-space:normal">${esc(estadoAlertas)}</p></div>
    </section>`;

  return layout({
    cliente, clientesDisponibles, activo: 'salud', titulo: 'Salud del agente', rol,
    barra: selectorPeriodo(base, periodo), contenido, ultimoDato: modelo.ultimoDato,
  });
}

module.exports = { renderSalud };
