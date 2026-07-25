-- Post-dedupe verification: must return 0 rows before/after unique index is OK.
SELECT
  phone_number_id,
  COUNT(*) AS active_rows
FROM public.tenant_integrations
WHERE is_active = true
  AND phone_number_id IS NOT NULL
  AND length(trim(phone_number_id)) > 0
GROUP BY phone_number_id
HAVING COUNT(*) > 1;
