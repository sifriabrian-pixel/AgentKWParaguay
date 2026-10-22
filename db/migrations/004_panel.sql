-- Marca y nota que el equipo pone desde el panel (Urgente, Asesor contactó,
-- Asignado, Descartado). Cada cambio queda además como evento en lead_events.
ALTER TABLE leads ADD COLUMN panel_prioridad TEXT;
ALTER TABLE leads ADD COLUMN panel_nota TEXT;
