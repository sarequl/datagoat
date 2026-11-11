-- Finisher (0900–0999): per-user Overview layout of a website (card order and hidden cards, set in
-- the dashboard's Customize mode). JSON, NULL = default layout. Written only when the user saves.
ALTER TABLE memberships ADD COLUMN overview_layout TEXT;
