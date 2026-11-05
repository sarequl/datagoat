-- Finisher (0900–0999): per-user website order for the All websites dashboard (DataFast's
-- drag-and-drop "Reorder websites"). NULL = not ordered yet (falls back to creation order).
-- No index: the column is only read through the memberships_user index path.
ALTER TABLE memberships ADD COLUMN position INTEGER;
