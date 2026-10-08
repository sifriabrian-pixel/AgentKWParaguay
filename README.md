# Agente KW Paraguay

Agente de WhatsApp (Cloud API + Claude) para Keller Williams Paraguay. Es un clon adaptado del agente de RE/MAX Impacta, con estado persistente en SQLite.

## Cómo está armado

| Archivo | Qué hace |
|---|---|
| `config/kw-py.js` | Todo lo específico de KW: flujos, criterios de calificación, campañas, asesores, templates |
| `prompts/kw-py.js` | System prompt (estático, cacheado) |
| `index.js` | Servidor HTTP: `GET/POST /webhook`, `GET /health` (devuelve solo `ok`) |
| `src/webhook.js` | Guarda referral y mensaje en la base **antes** de procesar |
| `src/agent.js` | Turno de conversación: cola por número, Claude, `guardar_datos`, envío |
| `src/claude.js` | Llamada a Claude con la herramienta `guardar_datos` |
| `src/campanas.js` | Resuelve `ad_id` → campaña (Meta Marketing API) y parsea `KWPY \| FLUJO \| ZONA \| ASESOR` |
| `src/repo.js` / `src/db.js` | SQLite (WAL) y migraciones en `db/migrations/*.sql` |

## Garantías

- **Nada crítico en memoria**: estado, historial, duplicados y pendientes viven en la base.
- **Duplicados**: `messages.wa_message_id` es UNIQUE; un reintento de Meta no genera otra respuesta.
- **Un mensaje por vez por número**: si el lead manda varios seguidos, se responden juntos.
- **Redeploy**: lo que quedó pendiente se retoma al arrancar. Una respuesta que estaba saliendo justo en el corte se marca `desconocido` y no se reenvía (se prefiere no duplicar).
- **Origen del lead**: el `referral` del anuncio se guarda antes de mirar el tipo de mensaje y antes de llamar a Claude.
- **Los tags del LLM no derivan**: quedan como eventos `llm_tag` (la derivación es de la Fase 2).

## Correr local

```bash
npm install
cp .env.example .env   # completar
npm start
```

## Tests

```bash
npm test          # unitarios con Claude falso y WhatsApp en modo prueba
npm run test:e2e  # servidor real: mata el proceso a mitad de turno y verifica que retome sin duplicar
```

## Railway

- Una sola instancia, **sin réplicas** (SQLite + bloqueo por número en proceso).
- Montar un volumen; la base queda en `$RAILWAY_VOLUME_MOUNT_PATH/kw.sqlite`.
- Variables: ver `.env.example`.
