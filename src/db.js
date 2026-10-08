// Conexión SQLite + migraciones versionadas (db/migrations/NNN_nombre.sql).
// Una sola instancia del servicio: el archivo vive en el volumen de Railway.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

function defaultPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'kw.sqlite');
  return path.join(__dirname, '..', 'data', 'kw.sqlite');
}

let db = null;

function open(dbPath = defaultPath()) {
  if (db) return db;
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(conn) {
  conn.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const aplicadas = new Set(conn.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const archivos = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const archivo of archivos) {
    const version = archivo.replace(/\.sql$/, '');
    if (aplicadas.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, archivo), 'utf8');
    conn.transaction(() => {
      conn.exec(sql);
      conn.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    })();
    console.log(`[db] Migración aplicada: ${version}`);
  }
}

function get() {
  if (!db) throw new Error('DB no abierta: llamar a db.open() primero');
  return db;
}

function close() {
  if (db) db.close();
  db = null;
}

module.exports = { open, get, close };
