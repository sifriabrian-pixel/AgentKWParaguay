// Configuración de Keller Williams Paraguay.
// Toda la lógica específica del cliente vive acá. Los valores '[PENDIENTE]'
// se completan cuando KW los defina; el código los trata como "no configurado".

module.exports = {
  tenant_id: 'kw-py',
  cliente: 'Keller Williams Paraguay',
  agente: { nombre: '[PENDIENTE]', tratamiento: '[PENDIENTE: usted|vos]' },
  zonaHoraria: 'America/Asuncion',
  franjaSeguimientos: { desde: '08:00', hasta: '21:00' },

  // Menú: Alquiler (alquiler) · Venta (compra) · Quiero vender mi propiedad
  // (captacion, solo venta) · Soy asesor (reclutamiento). Los propietarios que
  // quieren alquilar su propiedad no tienen flujo: datos.derivar_oficina = true.
  flujos: {
    compra:       { requeridos: ['tipo', 'zona', 'presupuesto'],       excluye: [], lead_type: 'commercial',  tag: 'HANDOFF_COMPRADOR' },
    alquiler:     { requeridos: ['tipo', 'zona', 'presupuesto'],       excluye: [], lead_type: 'commercial',  tag: 'HANDOFF_ARRENDATARIO' },
    captacion:    { requeridos: ['operacion', 'zona', 'dia', 'franja'], excluye: [], lead_type: 'commercial',  tag: 'HANDOFF_PROPIETARIO' },
    reclutamiento:{ requeridos: ['ciudad', 'disponibilidad', 'entrevistaConfirmada'], excluye: ['descalificado'], lead_type: 'recruitment', tag: 'AGENDA_ENTREVISTA' },
  },

  campanas: { prefijo: 'KWPY', separador: '|', flujos: { COMPRA: 'compra', ALQUILER: 'alquiler', CAPTACION: 'captacion', RECLUTAMIENTO: 'reclutamiento' } },

  asesores: [ /* { id, nombre, whatsapp, activo, flujos:[...], zonas:[...], proyectos:[...] } — PENDIENTE KW */ ],
  oficina: { nombre: 'Oficina', whatsapp: '[PENDIENTE]' },
  reclutamiento: { nombre: '[PENDIENTE]', whatsapp: '[PENDIENTE]' },

  templates: {
    avisoAsesor: 'nuevo_lead_asesor',
    seguimiento48h: { compra: '[PENDIENTE]', alquiler: '[PENDIENTE]', captacion: '[PENDIENTE]', reclutamiento: '[PENDIENTE]' },
    idioma: 'es',
  },

  // Aviso de protección de datos (se conserva de Impacta). URL de la política pendiente de KW.
  privacidad: { url: '[PENDIENTE]' },

  // Catálogo de propiedades que el agente puede ofrecer. Por ahora, 10 fichas
  // de prueba tomadas de kwparaguay.kw.com (todas en venta, Asunción y Lambaré).
  catalogo: { archivo: 'catalogo/kw-py-prueba.json' },

  // Preguntas frecuentes: KW todavía no pasó el contenido.
  // Formato: { pregunta, respuesta }
  faq: [],
};
