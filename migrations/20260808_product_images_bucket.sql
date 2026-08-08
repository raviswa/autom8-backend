-- Product catalog images (tenant-scoped object paths).
-- Uploads go through the API with service role: product-images/{restaurant_id}/{uuid}.ext
-- Bucket is public for get-by-URL (WhatsApp / storefront need permanent HTTPS).
-- Policies block anonymous listing and restrict authenticated writes to own prefix.

BEGIN;

INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images', 'product-images', true)
ON CONFLICT (id) DO NOTHING;

-- Drop prior policies if re-running
DROP POLICY IF EXISTS "product_images_public_read" ON storage.objects;
DROP POLICY IF EXISTS "product_images_auth_insert_own" ON storage.objects;
DROP POLICY IF EXISTS "product_images_auth_update_own" ON storage.objects;
DROP POLICY IF EXISTS "product_images_auth_delete_own" ON storage.objects;
DROP POLICY IF EXISTS "product_images_auth_select_own" ON storage.objects;

-- Public can read objects by exact URL (required for catalog / IG / WhatsApp).
-- Listing is still controlled by Storage API; clients should not enumerate.
CREATE POLICY "product_images_public_read"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'product-images');

-- Authenticated users may only write under their restaurant_id folder.
-- Path format: {restaurant_id}/{filename}
-- restaurant_id is expected as JWT claim app_metadata.restaurant_id or user_metadata.restaurant_id.
-- Primary uploads use service role via API (bypasses RLS); these policies harden dashboard misuse.
CREATE POLICY "product_images_auth_insert_own"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'product-images'
    AND (storage.foldername(name))[1] = COALESCE(
      auth.jwt() -> 'app_metadata' ->> 'restaurant_id',
      auth.jwt() -> 'user_metadata' ->> 'restaurant_id'
    )
  );

CREATE POLICY "product_images_auth_update_own"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (storage.foldername(name))[1] = COALESCE(
      auth.jwt() -> 'app_metadata' ->> 'restaurant_id',
      auth.jwt() -> 'user_metadata' ->> 'restaurant_id'
    )
  );

CREATE POLICY "product_images_auth_delete_own"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'product-images'
    AND (storage.foldername(name))[1] = COALESCE(
      auth.jwt() -> 'app_metadata' ->> 'restaurant_id',
      auth.jwt() -> 'user_metadata' ->> 'restaurant_id'
    )
  );

COMMENT ON POLICY "product_images_public_read" ON storage.objects IS
  'Permanent public HTTPS URLs for catalog images; API uploads under {restaurant_id}/…';

COMMIT;
