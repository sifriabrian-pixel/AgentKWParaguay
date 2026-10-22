// Fechas en el timezone del cliente. Los agentes guardan todo en UTC (ISO),
// pero "hoy", "este mes" y "fuera de horario" dependen de la hora local.

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

const formateadores = new Map();
function formateador(tz) {
  if (!formateadores.has(tz)) {
    formateadores.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
    }));
  }
  return formateadores.get(tz);
}

const DIAS_SEMANA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// { ymd: '2026-09-25', diaSemana: 5, minutos: 845 } en hora local del cliente
function partesLocales(fecha, tz) {
  const p = {};
  for (const { type, value } of formateador(tz).formatToParts(new Date(fecha))) p[type] = value;
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    diaSemana: DIAS_SEMANA[p.weekday],
    minutos: Number(p.hour) * 60 + Number(p.minute),
  };
}

function diaLocal(fecha, tz) {
  return partesLocales(fecha, tz).ymd;
}

// Instante UTC en que empieza el día local `ymd` (ej. '2026-09-25' en Manta → 05:00Z)
function inicioDiaLocal(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const p = partesLocales(guess, tz);
  const [py, pm, pd] = p.ymd.split('-').map(Number);
  const offset = Date.UTC(py, pm - 1, pd) + p.minutos * 60000 - guess;
  return guess - offset;
}

function sumarDias(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function esValidoYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));
}

// Período seleccionado + período anterior de igual duración.
// preset: '7' | '30' | 'mes' | 'custom' (con desde/hasta inclusivos)
function resolverPeriodo({ preset, desde, hasta }, tz, ahora = Date.now()) {
  const hoy = diaLocal(ahora, tz);
  let from, to, etiqueta;

  if (preset === 'custom' && esValidoYmd(desde)) {
    const hastaOk = esValidoYmd(hasta) && hasta >= desde ? hasta : hoy;
    from = inicioDiaLocal(desde, tz);
    to = Math.min(inicioDiaLocal(sumarDias(hastaOk, 1), tz), ahora);
    etiqueta = `${fechaCorta(desde)} – ${fechaCorta(hastaOk)}`;
  } else if (preset === 'mes') {
    from = inicioDiaLocal(hoy.slice(0, 8) + '01', tz);
    to = ahora;
    etiqueta = 'Este mes';
  } else {
    const dias = preset === '30' ? 30 : 7;
    preset = String(dias);
    from = inicioDiaLocal(sumarDias(hoy, -(dias - 1)), tz);
    to = ahora;
    etiqueta = `Últimos ${dias} días`;
  }

  const duracion = to - from;
  return { preset: preset || '7', desde, hasta, from, to, prevFrom: from - duracion, prevTo: from, etiqueta };
}

function fechaCorta(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

// Lista de días locales entre from y to (para la serie diaria)
function diasEntre(from, to, tz) {
  const dias = [];
  let dia = diaLocal(from, tz);
  const ultimo = diaLocal(to - 1, tz);
  while (dia <= ultimo && dias.length < 400) {
    dias.push(dia);
    dia = sumarDias(dia, 1);
  }
  return dias;
}

function fueraDeHorario(fecha, cliente) {
  const p = partesLocales(fecha, cliente.timezone);
  const franja = cliente.horario[p.diaSemana];
  if (!franja) return true;
  return p.minutos < franja[0] || p.minutos >= franja[1];
}

function tiempoRelativo(fecha, ahora = Date.now()) {
  if (!fecha) return '—';
  const min = Math.floor((ahora - new Date(fecha).getTime()) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  return dias === 1 ? 'ayer' : `hace ${dias} d`;
}

// "5 h", "2 d 3 h", "35 min"
function duracionCorta(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 48) return `${horas} h`;
  const dias = Math.floor(horas / 24);
  const resto = horas % 24;
  return resto ? `${dias} d ${resto} h` : `${dias} d`;
}

module.exports = {
  HORA_MS, DIA_MS, partesLocales, diaLocal, inicioDiaLocal, sumarDias, resolverPeriodo,
  diasEntre, fueraDeHorario, tiempoRelativo, duracionCorta, fechaCorta,
};
