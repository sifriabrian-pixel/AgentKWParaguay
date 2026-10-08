-- Esquema inicial del agente KW Paraguay.
-- Compatible con Postgres: solo TEXT / INTEGER, sin AUTOINCREMENT ni funciones
-- de SQLite. Los ids son UUID generados en la app; las fechas son ISO 8601 UTC
-- (TEXT) y los JSON se guardan como TEXT (en Postgres pasan a timestamptz / jsonb).

CREATE TABLE leads (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  wa_id            TEXT NOT NULL,
  nombre_perfil    TEXT,
  flujo            TEXT CHECK (flujo IN ('compra', 'alquiler', 'captacion', 'reclutamiento')),
  lead_type        TEXT CHECK (lead_type IN ('commercial', 'recruitment')),
  datos            TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'activo'
                   CHECK (status IN ('activo', 'calificado', 'derivado', 'sin_respuesta', 'cerrado')),
  asesor_id        TEXT,
  source           TEXT NOT NULL DEFAULT 'organico' CHECK (source IN ('ctwa', 'organico')),
  ad_id            TEXT,
  referral         TEXT,
  ctwa_clid        TEXT,
  campaign_id      TEXT,
  campaign_name    TEXT,
  adset_name       TEXT,
  ad_name          TEXT,
  campaign_status  TEXT CHECK (campaign_status IN ('ok', 'parse_failed', 'api_failed', 'sin_token')),
  campaign_flujo   TEXT,
  campaign_zona    TEXT,
  campaign_asesor  TEXT,
  consent_at       TEXT,
  last_inbound_at  TEXT,
  last_outbound_at TEXT,
  derived_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX leads_wa_idx ON leads (tenant_id, wa_id, created_at);
CREATE INDEX leads_ad_idx ON leads (tenant_id, ad_id);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  wa_id         TEXT NOT NULL,
  lead_id       TEXT REFERENCES leads (id),
  direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  wa_message_id TEXT UNIQUE,
  type          TEXT NOT NULL,
  body          TEXT,
  media_id      TEXT,
  tags          TEXT,
  -- in:  pendiente -> procesado
  -- out: enviando -> enviado -> entregado -> leido | fallido | desconocido
  status        TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  processed_at  TEXT
);
CREATE INDEX messages_wa_idx ON messages (tenant_id, wa_id, created_at);
CREATE INDEX messages_pending_idx ON messages (tenant_id, direction, status);

CREATE TABLE lead_events (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  lead_id    TEXT NOT NULL REFERENCES leads (id),
  type       TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX lead_events_lead_idx ON lead_events (lead_id, created_at);
CREATE INDEX lead_events_type_idx ON lead_events (tenant_id, type, created_at);

CREATE TABLE followups (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  lead_id    TEXT NOT NULL REFERENCES leads (id),
  kind       TEXT NOT NULL CHECK (kind IN ('2h', '48h')),
  due_at     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  sent_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX followups_due_idx ON followups (tenant_id, status, due_at);

CREATE TABLE asesor_rr (
  tenant_id  TEXT NOT NULL,
  pool_key   TEXT NOT NULL,
  counter    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, pool_key)
);
