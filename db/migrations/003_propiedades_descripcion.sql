-- Descripción completa de la ficha (la del sitio), para que el agente pueda
-- responder preguntas puntuales (cocheras, amenities, entrega, renta, etc.).
ALTER TABLE propiedades ADD COLUMN descripcion TEXT;
