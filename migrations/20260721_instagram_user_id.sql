-- Instagram Content Publishing prerequisites for packaged-food promos.
-- Handle alone is not enough — Graph publish needs the IG professional account id.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS instagram_user_id text;

COMMENT ON COLUMN tenants.instagram_user_id IS
  'Instagram professional (Business/Creator) user id for Content Publishing API';
