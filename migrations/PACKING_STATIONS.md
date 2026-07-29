# Kitchen vs Packing routing (`kitchen_station` → `kds_items.queue`)

One bill / one token. Lines split only on `kds_items.queue` (`cooking` | `packing`).

## Rules

| Source | Result |
|--------|--------|
| Tenant LOB `food_products` / `retail` / `b2b` / `psl` | All lines → packing |
| `kitchen_station` in `sweets_counter`, `packing`, `dispatch` | packing |
| Blank station + category Sweets / Savories / readymade / … | `sweets_counter` → packing |
| Aliases `savory`, `readymade`, `counter`, … | `sweets_counter` → packing |
| Other / blank | `assembly` → cooking |

Code: [`src/helpers/kdsQueue.js`](../src/helpers/kdsQueue.js) (`resolveKitchenStation`, `queueForStation`).

## Mixed order (cooked + readymade)

1. POS or WhatsApp creates **one** `orders` row.
2. Each line gets a `kds_items` row with `queue` cooking or packing.
3. Kitchen screen: `?queue=cooking`. Packing screen: `?queue=packing`.
4. Thermal KOT: cooking lines only.
5. Packing WhatsApp nudge notes when the same token also has kitchen items.

## Ops — Hotel Munafe data fix

In Supabase SQL editor, run:

[`20260729_munafe_readymade_packing_stations.sql`](./20260729_munafe_readymade_packing_stations.sql)

Preview with the SELECT in that file first. Leave live-fried items on `tawa` / `kadai` / `assembly`.

## Catalog upload

Excel `kitchen_station` for readymade Sweets & Savories: **`sweets_counter`**.
Blank + category Sweets/Savories defaults to packing after this deploy.

## Manual test matrix

| Order | Expect |
|-------|--------|
| Savories-only takeaway | Packing board only |
| Cooked-only | Kitchen board only |
| Mixed Idli + Mixture | Same token on both boards; packing alert mentions kitchen items |
| POS bill + WA prepay | Same split |
