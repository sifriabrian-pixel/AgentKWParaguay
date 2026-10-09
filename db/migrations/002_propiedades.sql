-- Catálogo de propiedades que el agente puede ofrecer (fichas).
-- Compatible con Postgres, igual que 001.

CREATE TABLE propiedades (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  operacion     TEXT NOT NULL CHECK (operacion IN ('venta', 'alquiler')),
  tipo          TEXT NOT NULL,
  barrio        TEXT,
  ciudad        TEXT,
  direccion     TEXT,
  dormitorios   INTEGER,
  banos         REAL,
  superficie_m2 REAL,
  terreno_m2    REAL,
  precio        REAL,
  moneda        TEXT CHECK (moneda IN ('USD', 'PYG')),
  asesor_nombre TEXT,
  url           TEXT,
  resumen       TEXT,
  activo        INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX propiedades_busqueda_idx ON propiedades (tenant_id, activo, operacion);
