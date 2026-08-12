-- =====================================================================
-- SeuBarba — RLS & Autorização (menor privilégio)
-- =====================================================================
-- Objetivo: um usuário nunca acessa/altera/exclui dados de outra barbearia
-- manipulando IDs, requests ou usando a anon key.
--
-- Modelo de identidade:
--   * auth.users            -> dono da barbearia (owner_id) e barbeiro (por e-mail)
--   * cliente               -> ANÔNIMO (agenda sem login). Escrita de agendamento
--                              e leitura por telefone passam por Edge Functions.
--   * admin                 -> e-mail único (is_platform_admin()). Ações elevadas
--                              (aprovar loja, trial, wallet, criar login de barbeiro,
--                              plano) só por Edge Function autenticada (service role).
--
-- Regra de ouro: a autorização NUNCA depende de IDs enviados pelo frontend.
-- Tudo é decidido por auth.uid() / auth.jwt() (claims assinados pelo Supabase)
-- e por EXISTS contra o banco — nunca por valores vindos do cliente.
--
-- IMPORTANTE: aplique com `supabase db push` (ou cole no SQL Editor). É idempotente
-- (drop policy if exists antes de create). Rode DEPOIS de subir as Edge Functions.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0) Funções auxiliares (SECURITY DEFINER para não recursar em RLS)
-- ---------------------------------------------------------------------

-- Admin da plataforma: e-mail do JWT VERIFICADO (assinado pelo Supabase).
-- Troque por uma tabela public.platform_admins se quiser mais de um admin.
create or replace function public.is_platform_admin()
returns boolean
language sql stable
as $$
  select coalesce(lower(auth.jwt() ->> 'email') = 'maycontuliofs@gmail.com', false);
$$;

-- O usuário logado é dono desta loja?
create or replace function public.owns_shop(p_shop uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.shops s
    where s.id = p_shop and s.owner_id = auth.uid()
  );
$$;

-- Nome do barbeiro logado (barbers.email == e-mail do JWT). NULL se não for barbeiro.
create or replace function public.my_barber_name()
returns text
language sql stable security definer set search_path = public
as $$
  select b.nome from public.barbers b
  where lower(b.email) = lower(coalesce(auth.jwt() ->> 'email',''))
  limit 1;
$$;

-- O usuário logado é barbeiro vinculado a esta loja?
create or replace function public.is_shop_barber(p_shop uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.barbers b
    join public.barber_shops bs on bs.barber_id = b.id
    where bs.shop_id = p_shop
      and lower(b.email) = lower(coalesce(auth.jwt() ->> 'email',''))
  );
$$;

revoke all on function public.is_platform_admin() from public;
revoke all on function public.owns_shop(uuid)       from public;
revoke all on function public.my_barber_name()      from public;
revoke all on function public.is_shop_barber(uuid)  from public;
grant execute on function public.is_platform_admin() to anon, authenticated;
grant execute on function public.owns_shop(uuid)       to authenticated;
grant execute on function public.my_barber_name()      to authenticated;
grant execute on function public.is_shop_barber(uuid)  to authenticated;

-- ---------------------------------------------------------------------
-- 1) SHOPS
-- ---------------------------------------------------------------------
-- Leitura pública: só via VIEW shops_public (colunas seguras + ativo=true).
-- Base table: dono lê a própria; admin lê todas. Nunca anon.
-- Escrita: dono/admin, e SÓ colunas não sensíveis (grant por coluna).
-- Colunas de plataforma (ativo, plano_id, trial_until, asaas_wallet, owner_id)
-- só mudam via Edge Function (service role). Ninguém as altera direto.

alter table public.shops enable row level security;
alter table public.shops force row level security;

revoke all on table public.shops from anon, authenticated;
grant select on table public.shops to authenticated;
grant insert on table public.shops to authenticated;
grant delete on table public.shops to authenticated;
-- UPDATE só nas colunas "do próprio negócio" — nunca ativo/plano/trial/wallet/owner_id:
grant update (nome, bairro, responsavel, email, telefone, cep, logradouro, numero,
              abre, fecha, almoco_ini, almoco_fim, dias, lat, lng, foto,
              cpf_cnpj, tipo_empresa, faturamento, nascimento)
  on table public.shops to authenticated;

-- Base shops: só dono e admin leem a linha COMPLETA (com email, cpf, asaas_wallet...).
-- Barbeiro NÃO lê a base (evita vazar asaas_wallet/PII do dono) — usa shops_public.
drop policy if exists shops_select on public.shops;
create policy shops_select on public.shops for select to authenticated
  using ( owner_id = auth.uid() or is_platform_admin() );

-- cria loja só em nome próprio E já nasce SEM aprovação/plano/trial/wallet
-- (senão daria pra "auto-aprovar" ou furar o paywall no próprio insert)
drop policy if exists shops_insert on public.shops;
create policy shops_insert on public.shops for insert to authenticated
  with check (
    owner_id = auth.uid()
    and coalesce(ativo, false) = false
    and plano_id is null
    and trial_until is null
    and asaas_wallet is null
  );

drop policy if exists shops_update on public.shops;
create policy shops_update on public.shops for update to authenticated
  using      ( owner_id = auth.uid() or is_platform_admin() )
  with check ( owner_id = auth.uid() or is_platform_admin() );

drop policy if exists shops_delete on public.shops;
create policy shops_delete on public.shops for delete to authenticated
  using ( owner_id = auth.uid() or is_platform_admin() );

-- VIEW pública (diretório de barbearias) — só colunas seguras, só lojas ativas.
-- Roda como o dono da view (bypassa RLS de propósito: é o catálogo público).
drop view if exists public.shops_public;
create view public.shops_public as
  select id, nome, bairro, lat, lng, telefone, foto,
         plano_id, trial_until, abre, fecha, almoco_ini, almoco_fim, dias
  from public.shops
  where ativo = true;
grant select on public.shops_public to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) SERVICES  (cardápio é público para leitura; escrita só do dono)
-- ---------------------------------------------------------------------
alter table public.services enable row level security;
alter table public.services force row level security;

revoke all on table public.services from anon, authenticated;
grant select on table public.services to anon, authenticated;     -- cardápio público (sem PII)
grant insert, update, delete on table public.services to authenticated;

drop policy if exists services_select on public.services;
create policy services_select on public.services for select
  using ( true );                              -- INTENCIONAL: cardápio é público, sem PII

drop policy if exists services_insert on public.services;
create policy services_insert on public.services for insert to authenticated
  with check ( owns_shop(shop_id) or is_platform_admin() );

drop policy if exists services_update on public.services;
create policy services_update on public.services for update to authenticated
  using      ( owns_shop(shop_id) or is_platform_admin() )
  with check ( owns_shop(shop_id) or is_platform_admin() );

drop policy if exists services_delete on public.services;
create policy services_delete on public.services for delete to authenticated
  using ( owns_shop(shop_id) or is_platform_admin() );

-- ---------------------------------------------------------------------
-- 3) BARBERS  (nome/foto/esp públicos via view; e-mail/telefone protegidos)
-- ---------------------------------------------------------------------
alter table public.barbers enable row level security;
alter table public.barbers force row level security;

revoke all on table public.barbers from anon, authenticated;
grant select on table public.barbers to authenticated;
grant insert on table public.barbers to authenticated;
grant delete on table public.barbers to authenticated;
-- SÓ estes campos são editáveis direto. email/user_id (vínculo de login)
-- só mudam via Edge Function barbearia-admin (service role).
grant update (nome, especialidades, telefone, foto) on table public.barbers to authenticated;

-- Leitura da base: admin (todos), dono de loja onde o barbeiro atua, ou o próprio barbeiro.
drop policy if exists barbers_select on public.barbers;
create policy barbers_select on public.barbers for select to authenticated
  using (
    is_platform_admin()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email',''))
    or exists (
      select 1 from public.barber_shops bs
      join public.shops s on s.id = bs.shop_id
      where bs.barber_id = barbers.id and s.owner_id = auth.uid()
    )
  );

-- Criar barbeiro: qualquer usuário logado (dono montando equipe). O vínculo com a
-- loja é o que dá poder, e esse é controlado por barber_shops (abaixo). email não é
-- gravável aqui (sem grant), então não dá pra "sequestrar" login criando barbeiro.
drop policy if exists barbers_insert on public.barbers;
create policy barbers_insert on public.barbers for insert to authenticated
  with check ( true );

drop policy if exists barbers_update on public.barbers;
create policy barbers_update on public.barbers for update to authenticated
  using (
    is_platform_admin()
    or exists (
      select 1 from public.barber_shops bs
      join public.shops s on s.id = bs.shop_id
      where bs.barber_id = barbers.id and s.owner_id = auth.uid()
    )
  )
  with check (
    is_platform_admin()
    or exists (
      select 1 from public.barber_shops bs
      join public.shops s on s.id = bs.shop_id
      where bs.barber_id = barbers.id and s.owner_id = auth.uid()
    )
  );

drop policy if exists barbers_delete on public.barbers;
create policy barbers_delete on public.barbers for delete to authenticated
  using (
    is_platform_admin()
    or exists (
      select 1 from public.barber_shops bs
      join public.shops s on s.id = bs.shop_id
      where bs.barber_id = barbers.id and s.owner_id = auth.uid()
    )
  );

-- VIEW pública dos barbeiros (escolha do cliente): sem e-mail/telefone.
drop view if exists public.barbers_public;
create view public.barbers_public as
  select id, nome, especialidades, foto from public.barbers;
grant select on public.barbers_public to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4) BARBER_SHOPS  (vínculo barbeiro<->loja; controlado pelo dono da loja)
-- ---------------------------------------------------------------------
alter table public.barber_shops enable row level security;
alter table public.barber_shops force row level security;

revoke all on table public.barber_shops from anon, authenticated;
grant select on table public.barber_shops to anon, authenticated; -- só ligações (sem PII), usado no catálogo
grant insert, delete on table public.barber_shops to authenticated;

drop policy if exists barber_shops_select on public.barber_shops;
create policy barber_shops_select on public.barber_shops for select
  using ( true );                              -- INTENCIONAL: quem atende onde é público

drop policy if exists barber_shops_insert on public.barber_shops;
create policy barber_shops_insert on public.barber_shops for insert to authenticated
  with check ( owns_shop(shop_id) or is_platform_admin() );

drop policy if exists barber_shops_delete on public.barber_shops;
create policy barber_shops_delete on public.barber_shops for delete to authenticated
  using ( owns_shop(shop_id) or is_platform_admin() );

-- ---------------------------------------------------------------------
-- 5) APPOINTMENTS  (o ponto mais sensível: PII de clientes)
-- ---------------------------------------------------------------------
-- Cliente é anônimo:
--   * INSERT  -> bloqueado direto; só via Edge Function "agendar" (service role,
--                recalcula preço e valida status).
--   * SELECT direto -> bloqueado para anon (não pode listar agenda alheia).
--     Disponibilidade do cliente -> RPC busy_slots() (só horários, sem PII).
--     "Meus agendamentos" (por telefone) -> Edge Function "meus-agendamentos".
--   * Dono/barbeiro/admin leem a agenda da PRÓPRIA loja (RLS).
--   * UPDATE/DELETE -> ninguém direto (só service role via função, se preciso).

alter table public.appointments enable row level security;
alter table public.appointments force row level security;

revoke all on table public.appointments from anon, authenticated;
grant select on table public.appointments to authenticated;   -- filtrado pela policy abaixo
-- Sem grant de INSERT/UPDATE/DELETE para anon/authenticated: tudo pela Edge Function.

drop policy if exists appointments_select on public.appointments;
create policy appointments_select on public.appointments for select to authenticated
  using (
    is_platform_admin()
    or owns_shop(shop_id)                                   -- dono vê a agenda da própria loja
    or ( is_shop_barber(shop_id) and barbeiro = my_barber_name() ) -- barbeiro vê só a dele
  );

-- (Sem policies de INSERT/UPDATE/DELETE => negado para todo mundo, menos service role.)

-- RPC de disponibilidade: devolve SÓ horários ocupados (minuto/barbeiro/servico),
-- nunca nome/telefone/preço do cliente. Aberta ao anon (cliente escolhendo horário).
-- p_dia nulo => todos os dias (o cliente filtra por dia no app). Sem PII.
create or replace function public.busy_slots(p_shop uuid, p_barbearia text, p_dia text)
returns table (dia text, minuto int, barbeiro text, servico text)
language sql stable security definer set search_path = public
as $$
  select a.dia::text, a.minuto, a.barbeiro, a.servico
  from public.appointments a
  where a.status is distinct from 'cancelado'
    and (p_dia is null or a.dia::text = p_dia)
    and (
      (p_shop is not null and a.shop_id = p_shop)
      or (p_shop is null and a.barbearia = p_barbearia)
    );
$$;
revoke all on function public.busy_slots(uuid, text, text) from public;
grant execute on function public.busy_slots(uuid, text, text) to anon, authenticated;

commit;

-- =====================================================================
-- Notas de rollout / dependências no frontend (ver SECURITY-RLS.md):
--   * Diretório público -> from('shops_public') / from('barbers_public')
--   * Disponibilidade    -> rpc('busy_slots', {...})
--   * Agendar            -> Edge Function "agendar"
--   * Meus agendamentos  -> Edge Function "meus-agendamentos"
--   * Login de barbeiro / aprovar / trial / wallet / plano -> Edge Functions
-- =====================================================================
