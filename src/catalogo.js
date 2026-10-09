// Catálogo de propiedades: se sincroniza desde el archivo JSON configurado
// (config.catalogo.archivo) al arrancar, y el agente lo consulta con la
// herramienta buscar_propiedades.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('../config/kw-py');

const T = config.tenant_id;
const MAX_RESULTADOS = 3;
const TOLERANCIA_PRECIO = 1.1; // se muestran opciones hasta 10% arriba del presupuesto

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Tipos equivalentes al buscar ("departamento" incluye monoambientes, etc.).
const TIPOS = {
  departamento: ['departamento', 'monoambiente', 'duplex', 'penthouse'],
  monoambiente: ['monoambiente'],
  casa: ['casa', 'duplex'],
  terreno: ['terreno', 'lote'],
  oficina: ['oficina'],
  local: ['local comercial'],
  'local comercial': ['local comercial'],
};

// Sube el archivo a la tabla: inserta/actualiza lo que está y desactiva lo que
// ya no figura. Idempotente: se puede correr en cada arranque.
function sync(archivo = config.catalogo?.archivo) {
  if (!archivo) return 0;
  const ruta = path.isAbsolute(archivo) ? archivo : path.join(__dirname, '..', archivo);
  if (!fs.existsSync(ruta)) {
    console.warn(`[catalogo] No existe ${archivo}`);
    return 0;
  }
  const items = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  const conn = db.get();
  const ts = new Date().toISOString();
  const upsert = conn.prepare(`
    INSERT INTO propiedades (id, tenant_id, operacion, tipo, barrio, ciudad, direccion, dormitorios, banos,
      superficie_m2, terreno_m2, precio, moneda, asesor_nombre, url, resumen, activo, updated_at)
    VALUES (@id, @tenant_id, @operacion, @tipo, @barrio, @ciudad, @direccion, @dormitorios, @banos,
      @superficie_m2, @terreno_m2, @precio, @moneda, @asesor_nombre, @url, @resumen, 1, @updated_at)
    ON CONFLICT (tenant_id, id) DO UPDATE SET
      operacion = excluded.operacion, tipo = excluded.tipo, barrio = excluded.barrio, ciudad = excluded.ciudad,
      direccion = excluded.direccion, dormitorios = excluded.dormitorios, banos = excluded.banos,
      superficie_m2 = excluded.superficie_m2, terreno_m2 = excluded.terreno_m2, precio = excluded.precio,
      moneda = excluded.moneda, asesor_nombre = excluded.asesor_nombre, url = excluded.url,
      resumen = excluded.resumen, activo = 1, updated_at = excluded.updated_at
  `);
  conn.transaction(() => {
    conn.prepare('UPDATE propiedades SET activo = 0 WHERE tenant_id = ?').run(T);
    for (const p of items) {
      upsert.run({
        barrio: null, ciudad: null, direccion: null, dormitorios: null, banos: null, superficie_m2: null,
        terreno_m2: null, precio: null, moneda: null, asesor_nombre: null, url: null, resumen: null,
        ...p, id: String(p.id), tenant_id: T, updated_at: ts,
      });
    }
  })();
  console.log(`[catalogo] ${items.length} propiedad(es) activas desde ${archivo}`);
  return items.length;
}

// Filtros: { operacion, tipo, zona, dormitorios_min, presupuesto_max, moneda }
// Devuelve { total, propiedades: [...hasta 3], nota }
function buscar(filtros = {}) {
  let props = db.get().prepare('SELECT * FROM propiedades WHERE tenant_id = ? AND activo = 1').all(T);
  const notas = [];

  if (filtros.operacion) props = props.filter((p) => p.operacion === filtros.operacion);

  if (filtros.tipo) {
    const buscados = TIPOS[norm(filtros.tipo)] || [norm(filtros.tipo)];
    props = props.filter((p) => buscados.includes(norm(p.tipo)));
  }

  if (filtros.zona) {
    const z = norm(filtros.zona);
    props = props.filter((p) => norm([p.barrio, p.ciudad, p.direccion, p.resumen].join(' ')).includes(z));
  }

  if (filtros.dormitorios_min) {
    props = props.filter((p) => p.dormitorios == null || p.dormitorios >= filtros.dormitorios_min);
  }

  if (filtros.presupuesto_max) {
    if (filtros.moneda) {
      const otraMoneda = props.filter((p) => p.moneda && p.moneda !== filtros.moneda).length;
      props = props.filter((p) => p.moneda !== filtros.moneda || p.precio == null || p.precio <= filtros.presupuesto_max * TOLERANCIA_PRECIO);
      if (otraMoneda) notas.push(`Hay ${otraMoneda} opción(es) con precio en otra moneda: no se convierte, se muestran sin filtrar por precio.`);
    } else {
      notas.push('No se indicó la moneda del presupuesto: no se filtró por precio.');
    }
  }

  props.sort((a, b) => (a.precio || 0) - (b.precio || 0));
  return {
    total: props.length,
    propiedades: props.slice(0, MAX_RESULTADOS).map((p) => ({
      id: p.id,
      operacion: p.operacion,
      tipo: p.tipo,
      ubicacion: [p.barrio, p.ciudad].filter(Boolean).join(', '),
      dormitorios: p.dormitorios,
      banos: p.banos,
      superficie_m2: p.superficie_m2,
      terreno_m2: p.terreno_m2,
      precio: p.precio,
      moneda: p.moneda,
      resumen: p.resumen,
      url: p.url,
    })),
    nota: notas.join(' ') || undefined,
  };
}

module.exports = { sync, buscar };
