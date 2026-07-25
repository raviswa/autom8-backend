-- Diagnostic: active duplicate phone_number_id rows blocking
-- tenant_integrations_phone_number_id_active_uidx
-- Run in Supabase SQL editor and keep the result (or screenshot).

SELECT
  ti.phone_number_id,
  COUNT(*) AS active_rows,
  array_agg(ti.id ORDER BY COALESCE(ti.updated_at, ti.created_at) DESC NULLS LAST) AS integration_ids,
  array_agg(ti.restaurant_id ORDER BY COALESCE(ti.updated_at, ti.created_at) DESC NULLS LAST) AS restaurant_ids,
  array_agg(COALESCE(ti.updated_at, ti.created_at) ORDER BY COALESCE(ti.updated_at, ti.created_at) DESC NULLS LAST) AS timestamps
FROM public.tenant_integrations ti
WHERE ti.is_active = true
  AND ti.phone_number_id IS NOT NULL
  AND length(trim(ti.phone_number_id)) > 0
GROUP BY ti.phone_number_id
HAVING COUNT(*) > 1
ORDER BY active_rows DESC, ti.phone_number_id;
