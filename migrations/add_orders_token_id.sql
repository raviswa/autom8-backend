alter table orders
  add column if not exists token_id uuid references walk_in_tokens(id);

create index if not exists idx_orders_token_id on orders(token_id);
