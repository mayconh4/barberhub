-- =====================================================================
-- SeuBarba — payment_intents (idempotência + auditoria de cobranças)
-- =====================================================================
-- Registra cada tentativa de cobrança para:
--   * IDEMPOTÊNCIA: a mesma reserva (mesma loja+telefone+serviços+dia+hora+forma)
--     nunca gera duas cobranças (idem_key único). Protege contra replay e
--     duplo-clique/retry de rede.
--   * RATE LIMIT: contar tentativas por telefone numa janela de tempo.
--   * STATUS confiável: o poll de status só aceita paymentId que ESTA função criou.
--
-- Só o service role (Edge Function) acessa. Sem policies => negado para anon e
-- authenticated (o service role tem BYPASSRLS).
--
-- Aplique DEPOIS das migrations anteriores.
-- =====================================================================
begin;

create table if not exists public.payment_intents (
  id               uuid primary key default gen_random_uuid(),
  idem_key         text not null unique,   -- determinístico da reserva (server-side)
  shop_id          uuid,
  cliente_zap      text,
  cpf              text,
  forma            text,                    -- PIX | CREDIT_CARD
  valor            numeric,                 -- valor AUTORITATIVO cobrado (do banco)
  asaas_payment_id text,
  status           text,                    -- creating | pending | RECEIVED | ...
  created_at       timestamptz not null default now()
);

create index if not exists payment_intents_zap_time on public.payment_intents (cliente_zap, created_at desc);
create index if not exists payment_intents_asaas    on public.payment_intents (asaas_payment_id);

alter table public.payment_intents enable row level security;
alter table public.payment_intents force row level security;
revoke all on table public.payment_intents from anon, authenticated;
-- Intencionalmente SEM policies: ninguém além do service role toca nesta tabela.

commit;
