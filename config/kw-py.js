// Configuración de Keller Williams Paraguay.
// Toda la lógica específica del cliente vive acá. Los valores '[PENDIENTE]'
// se completan cuando KW los defina; el código los trata como "no configurado".

module.exports = {
  tenant_id: 'kw-py',
  cliente: 'Keller Williams Paraguay',
  agente: { nombre: '[PENDIENTE]', tratamiento: '[PENDIENTE: usted|vos]' },
  zonaHoraria: 'America/Asuncion',
  franjaSeguimientos: { desde: '08:00', hasta: '21:00' },

  // Etapa de pruebas: quien escriba exactamente este mensaje arranca de cero
  // (ficha nueva, sin historial). APAGAR antes de abrir el número al público.
  pruebas: { reiniciar: '#reiniciar' },

  // Menú: Alquiler (alquiler) · Venta (compra) · Quiero vender mi propiedad
  // (captacion, solo venta) · Quiero ser asesor (reclutamiento). Los propietarios que
  // quieren alquilar su propiedad no tienen flujo: datos.derivar_oficina = true.
  flujos: {
    // requeridos: lo que hace falta para derivar. requeridosPuntual: lo mismo
    // cuando el lead consulta por una propiedad del catálogo (datos.propiedad_id).
    // KW (2026-10-15): el agente deriva, no agenda. Sin día de contacto, forma
    // de pago ni visita de tasación; el asesor coordina todo.
    compra:       { requeridos: ['tipo', 'zona', 'presupuesto'], requeridosPuntual: ['propiedad_id', 'nombre'],                excluye: [], lead_type: 'commercial',  tag: 'HANDOFF_COMPRADOR' },
    alquiler:     { requeridos: ['tipo', 'zona', 'presupuesto'], requeridosPuntual: ['propiedad_id', 'nombre', 'presupuesto'], excluye: [], lead_type: 'commercial',  tag: 'HANDOFF_ARRENDATARIO' },
    captacion:    { requeridos: ['operacion', 'tipo', 'zona'], excluye: [], lead_type: 'commercial',  tag: 'HANDOFF_PROPIETARIO' },
    reclutamiento:{ requeridos: ['ciudad', 'disponibilidad', 'entrevistaConfirmada'], excluye: ['descalificado'], lead_type: 'recruitment', tag: 'AGENDA_ENTREVISTA' },
  },

  campanas: { prefijo: 'KWPY', separador: '|', flujos: { COMPRA: 'compra', ALQUILER: 'alquiler', CAPTACION: 'captacion', RECLUTAMIENTO: 'reclutamiento' } },

  // A quién se derivan los leads (ver src/ruteo.js). Piloto: reclutamiento →
  // responsable; compra/alquiler/captacion → asesores del flujo, por turnos;
  // si no hay nadie → oficina. zonas y proyectos todavía no se usan para rutear.
  // PRUEBA: un solo número (Brian) en los tres roles, hasta que KW pase su lista.
  asesores: [
    { id: 'prueba-brian', nombre: 'Brian (prueba)', whatsapp: '5493415907951', activa: true, flujos: ['compra', 'alquiler', 'captacion'], zonas: [], proyectos: [] },
  ],
  oficina: { nombre: 'Oficina', whatsapp: '5493415907951' },
  reclutamiento: { nombre: 'Reclutamiento', whatsapp: '5493415907951' },

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
