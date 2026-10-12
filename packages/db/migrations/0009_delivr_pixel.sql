-- Delivr resolves through its own pixel and cookie, one pixel per site. The id is public
-- (it is in the script URL on the customer's page). NULL = the site has no Delivr pixel and
-- the resolution step uses the mock provider for it.
ALTER TABLE sites ADD COLUMN delivr_pixel_id TEXT;
-- The founder's site got its pixel on Oct 5 (made with the "Delivr setup" workflow).
UPDATE sites SET delivr_pixel_id = '11111111-2222-3333-4444-555555555555' WHERE id = 'site_yardsign';
