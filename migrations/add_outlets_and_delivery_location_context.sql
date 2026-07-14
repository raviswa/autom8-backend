create table if not exists outlets (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references tenants(id),
  name text not null,
  address text,
  lat float8 not null,
  lng float8 not null,
  delivery_radius_km numeric not null default 5,
  delivery_charge numeric default 0,
  is_active boolean default true,
  created_at timestamptz default now()
);

create index if not exists idx_outlets_restaurant on outlets(restaurant_id);

alter table walk_in_tokens
  add column if not exists delivery_lat float8,
  add column if not exists delivery_lng float8,
  add column if not exists delivery_address text,
  add column if not exists outlet_id uuid references outlets(id),
  add column if not exists pending_address_candidates jsonb,
  add column if not exists awaiting_custom_address boolean default false;
