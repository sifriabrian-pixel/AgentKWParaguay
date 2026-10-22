// En el panel Sifer v2, "Salud del agente" muestra el estado de las alertas
// por email. En KW todavía no hay alertas por email.
function estado() {
  return 'Las alertas por email no están activadas para este agente. Los calificados sin derivar se ven en esta pantalla.';
}

module.exports = { estado };
