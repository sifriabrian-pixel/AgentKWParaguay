# Mejoras pendientes (anotadas durante el refactor del core)

Cosas que vi al separar el core del transporte. **Ninguna está implementada**: el
refactor no cambia el comportamiento. Ordenadas por impacto.

## Afectan al lead o a la atribución

1. **El flujo "consulta por una propiedad puntual" cierra sin presupuesto.**
   El prompt pide propósito, nombre y forma de pago, y cierra con
   `[HANDOFF_COMPRADOR]`. Pero `config.flujos.compra.requeridos` exige
   `presupuesto`. Resultado: esos leads se derivan con `qualified = false`, y el
   gate del QA ("derivar sin calificar = 0") los va a marcar. Hay que decidir:
   o el prompt pide el presupuesto también acá, o este camino tiene sus propios
   requeridos (por ejemplo `propiedad_id` + `formaPago`).

2. **Un segundo flujo pierde el origen y el aviso de privacidad.**
   `abrir_flujo_adicional` crea un lead nuevo solo con nombre y flujo. Queda como
   `organico` aunque haya venido de un anuncio, y con `consent_at` vacío, así que
   el agente vuelve a mandar el aviso de protección de datos.

3. **Si la respuesta no se pudo enviar, el lead se queda sin respuesta.**
   El mensaje entrante ya quedó `procesado` y el saliente `fallido` se excluye del
   historial. No hay reintento del envío, y en el turno siguiente el agente no
   sabe que su respuesta anterior nunca llegó.

4. **Un fallo transitorio de Meta deja al lead sin campaña para siempre.**
   Con `campaign_status = 'api_failed'` (o `'sin_token'`) no se vuelve a
   consultar el anuncio. Se pierde el flujo definido por la pauta para ese lead.

5. **El CV solo se reenvía si el flujo ya es `reclutamiento` en ese turno.**
   Si el postulante manda el CV antes de que el agente identifique el flujo, no
   se reenvía ni se reintenta después. Además, cualquier imagen enviada en ese
   flujo se reenvía como "Documentación de postulante".

## A resolver cuando se construya la derivación (Fase 2)

6. **`pide_humano` y `derivar_oficina` son solo datos.** No generan ninguna
   acción: un lead que pide hablar con una persona no dispara nada. El core hoy
   solo emite `handoff` cuando aparece un tag de cierre.

7. **El tag de derivación se puede repetir.** `derived_at` nunca se escribe, así
   que nada impide que el LLM vuelva a poner `[HANDOFF_*]` en un turno posterior.
   La acción `handoff` sale cada vez; "derivar una sola vez" hay que
   implementarlo con `derived_at`.

8. **Nada valida los datos antes de derivar.** El LLM decide cuándo cerrar.
   `state.qualified` ya está disponible para bloquear o avisar, pero hoy no
   decide nada (a propósito).

9. **Tablas sin uso:** `followups` y `asesor_rr` existen en el esquema y ningún
   código las lee ni las escribe. `core.tick()` devuelve vacío hasta que se
   construyan los seguimientos.

## Seguridad y robustez

10. **Sin `WHATSAPP_APP_SECRET` el webhook acepta cualquier POST.**
    `verifySignature` devuelve `true` si falta la variable; solo hay un aviso al
    arrancar. En producción debería rechazar.

11. **Presupuestos con texto se parsean mal.** `sanitizeDatos` se queda con los
    dígitos: "120 mil" queda en 120 y "150k" en 150. Solo pasa si el LLM manda
    el presupuesto como texto en vez de número.

12. **Si el LLM encadena 4 vueltas de herramientas sin escribir**, el turno
    termina con "no logré entender su mensaje" aunque el mensaje del lead haya
    sido claro (`MAX_VUELTAS = 4` en `claude.js`).
