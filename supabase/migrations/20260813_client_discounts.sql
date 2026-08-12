-- =====================================================================
-- SeuBarba — Descontos por cliente no BANCO (preço 100% validável no servidor)
-- =====================================================================
-- Antes: o desconto do "próximo corte" ficava no localStorage do barbeiro e o
-- percentual ia do frontend para a cobrança — ou seja, adulterável (limitado a
-- 0..90%, mas ainda controlado pelo cliente).
--
-- Agora: o desconto vive em public.client_discounts. O dono/admin gerencia (RLS);
-- as Edge Functions de cobrança/agendamento LEEM o desconto do banco e ignoram
-- qualquer valor mandado pelo cliente. O cliente anônimo só enxerga o próprio
-- percentual (para exibir o preço) via a função discount_for().
--
-- Aplique DEPOIS de 20260812_rls_security.sql (usa owns_shop/is_platform_admin).
-- =====================================================================
begin;

create table if not exists public.client_discounts (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  cliente_nome text not null,        -- guardado NORMALIZADO: lower(btrim(nome))
  pct         int  not null check (pct between 0 and 90),
  updated_at  timestamptz not null default now(),
  unique (shop_id, cliente_nome)
);
create index if not exists client_discounts_shop on public.client_discounts(shop_id);

alter table public.client_discounts enable row level security;
alter table public.client_discounts force row level security;

revoke all on table public.client_discounts from anon, authenticated;
grant select, insert, update, delete on table public.client_discounts to authenticated;

-- Só o dono da loja (ou admin) gerencia os descontos da PRÓPRIA loja.
drop policy if exists client_discounts_sel on public.client_discounts;
create policy client_discounts_sel on public.client_discounts for select to authenticated
  using ( owns_shop(shop_id) or is_platform_admin() );
drop policy if exists client_discounts_ins on public.client_discounts;
create policy client_discounts_ins on public.client_discounts for insert to authenticated
  with check ( owns_shop(shop_id) or is_platform_admin() );
drop policy if exists client_discounts_upd on public.client_discounts;
create policy client_discounts_upd on public.client_discounts for update to authenticated
  using ( owns_shop(shop_id) or is_platform_admin() )
  with check ( owns_shop(shop_id) or is_platform_admin() );
drop policy if exists client_discounts_del on public.client_discounts;
create policy client_discounts_del on public.client_discounts for delete to authenticated
  using ( owns_shop(shop_id) or is_platform_admin() );

-- Cliente anônimo: só consulta o percentual (int) do próprio nome, para exibir o
-- preço com desconto. Não lê a tabela (sem varrer quem tem desconto em massa além
-- do nome consultado). A cobrança recalcula tudo no servidor de qualquer forma.
create or replace function public.discount_for(p_shop uuid, p_nome text)
returns int language sql stable security definer set search_path = public as $$
  select coalesce((
    select pct from public.client_discounts
    where shop_id = p_shop and cliente_nome = lower(btrim(p_nome))
    limit 1
  ), 0);
$$;
revoke all on function public.discount_for(uuid, text) from public;
grant execute on function public.discount_for(uuid, text) to anon, authenticated;

commit;
