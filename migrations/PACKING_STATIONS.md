# Kitchen vs Packing routing (`kitchen_station` → `kds_items.queue`)

One bill / one token. Lines split only on `kds_items.queue` (`cooking` | `packing`).

## Rules

| Source | Result |
|--------|--------|
| Tenant LOB `food_products` / `retail` / `b2b` / `psl` | All lines → packing |
| `kitchen_station` in `sweets_counter`, `packing`, `dispatch` | packing |
| Category Sweets / Savories / readymade + blank **or** legacy `assembly` | `sweets_counter` → packing |
| Aliases `savory`, `readymade`, `counter`, … | `sweets_counter` → packing |
| Explicit hot stations (`tawa`, `steamer`, `kadai`, `beverages`, `cold`) | cooking |
| Other blank | `assembly` → cooking |

Code: [`src/helpers/kdsQueue.js`](../src/helpers/kdsQueue.js) (`resolveKitchenStation`, `queueForStation`).

## Mixed order (cooked + readymade)

1. POS or WhatsApp creates **one** `orders` row.
2. Each line gets a `kds_items` row with `queue` cooking or packing.
3. Kitchen screen: `?queue=cooking`. Packing screen: `?queue=packing` / `/dashboard/packing`.
4. Thermal KOT: cooking lines only.
5. Packing WhatsApp nudge notes when the same token also has kitchen items.

## Catalog upload

- Excel **`id` is optional** — blank → autogenerate; colliding ids keep the existing SKU id or get a new auto id (no unique-constraint failures).
- Blank **`kitchen_station` on re-upload** preserves the DB value (does not wipe `sweets_counter` back to `assembly`).
- Station is shown in Menu management and upload preview.

## Ops — Hotel Munafe data + live ticket repair

In Supabase SQL editor, run:

[`20260729_munafe_readymade_packing_stations.sql`](./20260729_munafe_readymade_packing_stations.sql)

1. Sets Sweets/Savories (+ legacy `assembly`) menu rows → `sweets_counter`.
2. Requeues open `pending` / `in_progress` cooking tickets for those items → `queue=packing`.

Leave live-fried items on `tawa` / `kadai` / `assembly` with non-readymade categories.

After SQL + backend/frontend deploy: refresh Kitchen and Packing — sweets/muruku/mixture should leave Kitchen and appear on Packing. Mixed tokens (e.g. dosa + sweets) show on both boards with the same token.

## Manual test matrix

| Order | Expect |
|-------|--------|
| Savories-only takeaway | Packing board only |
| Cooked-only | Kitchen board only |
| Mixed Idli + Mixture | Same token on both boards |
| Re-upload Excel with blank station | Does not wipe `sweets_counter` |
| Upload without `id` / colliding ids | Auto ID or keep existing; no unique crashes |
