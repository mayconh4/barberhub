-- =====================================================================
-- SeuBarba — Hardening: throttle de acesso (rate limit) para Edge Functions
-- =====================================================================
-- Usado por endpoints anônimos que leem dados por identificador fraco
-- (ex.: meus-agendamentos por telefone) para conter enumeração/abuso.
-- Só o service role acessa (sem policies).
-- =====================================================================
begin;

create table if not exists public.access_throttle (
  id         uuid primary key default gen_random_uuid(),
  scope      text not null,     -- ex.: 'meus-agendamentos'
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists access_throttle_lookup on public.access_throttle (scope, ip, created_at desc);

alter table public.access_throttle enable row level security;
alter table public.access_throttle force row level security;
revoke all on table public.access_throttle from anon, authenticated;
-- Sem policies: só o service role (BYPASSRLS) toca nesta tabela.

commit;
