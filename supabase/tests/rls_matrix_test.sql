-- =====================================================================
-- Matriz de testes de RLS / autorização — SeuBarba
-- =====================================================================
-- Rode no SQL Editor do Supabase (ou psql) DEPOIS de aplicar
-- 20260812_rls_security.sql. É totalmente transacional e faz ROLLBACK no
-- final: NÃO deixa nenhum dado de teste no banco.
--
-- Simula 3 atores mudando `role` + `request.jwt.claims` (é o que auth.uid()
-- e auth.jwt() leem por baixo) e verifica cada célula da matriz:
--
--   CLIENTE (anon):  SELECT próprio? / SELECT outra loja? / UPDATE?  -> esperado
--   DONO A:          própria loja permitido / outra loja negado
--   BARBEIRO de A:   própria operação permitido / outra loja negado
--
-- Cada verificação imprime PASS/FAIL via RAISE. Procure por "FAIL".
-- =====================================================================
begin;

-- ---- Seed (como postgres; desliga FK só para semear sem precisar de auth.users) ----
set local session_replication_role = replica;

-- ids fixos de teste
-- ownerA = 1111..., ownerB = 2222..., admin = e-mail admin, barberA vinculado à loja A
insert into public.shops (id, owner_id, nome, bairro, ativo, telefone, email, cpf_cnpj, asaas_wallet, plano_id, lat, lng)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Loja A', 'Centro', true,  '31999990000', 'a@a.com', '12345678900', 'WALLET_A', 'sub_A', -20.0, -44.0),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Loja B', 'Bairro', true,  '31988880000', 'b@b.com', '98765432100', 'WALLET_B', 'sub_B', -21.0, -45.0);

insert into public.services (id, shop_id, nome, preco, duracao_min)
values
  ('cccccccc-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Corte A', 40, 30),
  ('cccccccc-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000002', 'Corte B', 50, 30);

insert into public.barbers (id, nome, especialidades, email)
values ('dddddddd-0000-0000-0000-0000000000a1', 'Barbeiro A', array['Corte'], 'barbeiroa@test.com');

insert into public.barber_shops (shop_id, barber_id)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a1');

insert into public.appointments (shop_id, barbearia, barbeiro, cliente_nome, cliente_zap, servico, preco, dia, minuto, status)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Loja A', 'Barbeiro A', 'Cliente A1', '31900000001', 'Corte A', 40, '2026-08-20', 600, 'pago'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Loja B', 'Barbeiro B', 'Cliente B1', '31900000002', 'Corte B', 50, '2026-08-20', 660, 'pago');

set local session_replication_role = origin;

-- ---- Helpers ----
-- conta linhas visíveis; -1 se faltar privilégio (grant); -2 outro erro
create or replace function pg_temp.cnt(q text) returns int language plpgsql as $$
declare n int;
begin execute 'select count(*) from ('||q||') t' into n; return n;
exception when insufficient_privilege then return -1; when others then return -2; end $$;

-- tenta uma escrita; true = permitida, false = negada (grant de coluna OU RLS)
create or replace function pg_temp.wr(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return true;
exception when insufficient_privilege then return false; when others then return false; end $$;

create or replace function pg_temp.chk(label text, expected boolean, actual boolean) returns void language plpgsql as $$
begin
  if expected = actual then raise notice 'PASS  %', label;
  else raise warning 'FAIL  % (esperado=%, obtido=%)', label, expected, actual; end if;
end $$;

-- atalhos de ator
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin set local role anon; perform set_config('request.jwt.claims', '{}', true); end $$;
create or replace function pg_temp.as_user(sub text, email text) returns void language plpgsql as $$
begin set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',sub,'email',email,'role','authenticated')::text, true);
end $$;

-- =====================================================================
-- CLIENTE (anônimo, role anon)
-- =====================================================================
select pg_temp.as_anon();
select pg_temp.chk('CLIENTE: NÃO lê a base shops (só a view pública)',        false, pg_temp.cnt('select 1 from public.shops') >= 0);
select pg_temp.chk('CLIENTE: lê o diretório público (shops_public)',          true,  pg_temp.cnt('select 1 from public.shops_public') >= 0);
select pg_temp.chk('CLIENTE: NÃO lê appointments (agenda alheia)',            false, pg_temp.cnt('select 1 from public.appointments') >= 0);
select pg_temp.chk('CLIENTE: lê o cardápio público (services)',              true,  pg_temp.cnt('select 1 from public.services') >= 0);
select pg_temp.chk('CLIENTE: busy_slots devolve horários (sem PII)',          true,  pg_temp.cnt($$select 1 from public.busy_slots('aaaaaaaa-0000-0000-0000-000000000001', 'Loja A', null)$$) >= 0);
select pg_temp.chk('CLIENTE: NÃO cria appointment direto',                    false, pg_temp.wr($$insert into public.appointments(shop_id,barbearia,cliente_zap,servico,preco,dia,minuto,status) values ('aaaaaaaa-0000-0000-0000-000000000001','Loja A','31900000009','x',1,'2026-08-21',600,'pago')$$));
select pg_temp.chk('CLIENTE: NÃO altera uma barbearia',                       false, pg_temp.wr($$update public.shops set nome='hack' where id='aaaaaaaa-0000-0000-0000-000000000001'$$));
select pg_temp.chk('CLIENTE: NÃO altera preço de serviço',                    false, pg_temp.wr($$update public.services set preco=1 where id='cccccccc-0000-0000-0000-0000000000a1'$$));

-- =====================================================================
-- DONO A (owner_id = 1111...)
-- =====================================================================
select pg_temp.as_user('11111111-1111-1111-1111-111111111111', 'a@a.com');
select pg_temp.chk('DONO A: vê SÓ a própria loja (1 linha)',                  true,  pg_temp.cnt('select 1 from public.shops') = 1);
select pg_temp.chk('DONO A: NÃO vê a loja B',                                 true,  pg_temp.cnt($$select 1 from public.shops where id='bbbbbbbb-0000-0000-0000-000000000002'$$) = 0);
select pg_temp.chk('DONO A: vê SÓ a própria agenda (1 linha)',                true,  pg_temp.cnt('select 1 from public.appointments') = 1);
select pg_temp.chk('DONO A: NÃO vê agendamentos da loja B',                   true,  pg_temp.cnt($$select 1 from public.appointments where shop_id='bbbbbbbb-0000-0000-0000-000000000002'$$) = 0);
select pg_temp.chk('DONO A: atualiza dados da PRÓPRIA loja',                  true,  pg_temp.wr($$update public.shops set bairro='Novo' where id='aaaaaaaa-0000-0000-0000-000000000001'$$));
select pg_temp.chk('DONO A: NÃO atualiza a loja B',                           false, pg_temp.wr($$update public.shops set bairro='hack' where id='bbbbbbbb-0000-0000-0000-000000000002'$$));
select pg_temp.chk('DONO A: NÃO muda ativo (coluna de plataforma)',           false, pg_temp.wr($$update public.shops set ativo=true where id='aaaaaaaa-0000-0000-0000-000000000001'$$));
select pg_temp.chk('DONO A: NÃO muda plano_id (coluna de plataforma)',        false, pg_temp.wr($$update public.shops set plano_id='x' where id='aaaaaaaa-0000-0000-0000-000000000001'$$));
select pg_temp.chk('DONO A: NÃO muda asaas_wallet (desvio de split)',         false, pg_temp.wr($$update public.shops set asaas_wallet='ME' where id='aaaaaaaa-0000-0000-0000-000000000001'$$));
select pg_temp.chk('DONO A: gerencia serviço da PRÓPRIA loja',                true,  pg_temp.wr($$update public.services set preco=42 where id='cccccccc-0000-0000-0000-0000000000a1'$$));
select pg_temp.chk('DONO A: NÃO mexe em serviço da loja B',                   false, pg_temp.wr($$update public.services set preco=1 where id='cccccccc-0000-0000-0000-0000000000b1'$$));
select pg_temp.chk('DONO A: NÃO grava barbers.email (vínculo de login)',      false, pg_temp.wr($$update public.barbers set email='x@x' where id='dddddddd-0000-0000-0000-0000000000a1'$$));
select pg_temp.chk('DONO A: NÃO adiciona barbeiro na loja B',                 false, pg_temp.wr($$insert into public.barber_shops(shop_id,barber_id) values ('bbbbbbbb-0000-0000-0000-000000000002','dddddddd-0000-0000-0000-0000000000a1')$$));

-- =====================================================================
-- DONO B — não enxerga nada de A (simétrico)
-- =====================================================================
select pg_temp.as_user('22222222-2222-2222-2222-222222222222', 'b@b.com');
select pg_temp.chk('DONO B: NÃO vê a loja A',                                 true,  pg_temp.cnt($$select 1 from public.shops where id='aaaaaaaa-0000-0000-0000-000000000001'$$) = 0);
select pg_temp.chk('DONO B: NÃO vê a agenda de A',                            true,  pg_temp.cnt($$select 1 from public.appointments where shop_id='aaaaaaaa-0000-0000-0000-000000000001'$$) = 0);
select pg_temp.chk('DONO B: NÃO altera a loja A',                             false, pg_temp.wr($$update public.shops set nome='hack' where id='aaaaaaaa-0000-0000-0000-000000000001'$$));

-- =====================================================================
-- BARBEIRO de A (login = barbeiroa@test.com, nome = "Barbeiro A")
-- =====================================================================
select pg_temp.as_user('33333333-3333-3333-3333-333333333333', 'barbeiroa@test.com');
select pg_temp.chk('BARBEIRO A: vê o PRÓPRIO agendamento em A',               true,  pg_temp.cnt('select 1 from public.appointments') = 1);
select pg_temp.chk('BARBEIRO A: NÃO vê agendamentos da loja B',               true,  pg_temp.cnt($$select 1 from public.appointments where shop_id='bbbbbbbb-0000-0000-0000-000000000002'$$) = 0);
select pg_temp.chk('BARBEIRO A: NÃO lê a base shops (evita vazar wallet/PII)',false, pg_temp.cnt($$select 1 from public.shops where id='aaaaaaaa-0000-0000-0000-000000000001'$$) >= 0);
select pg_temp.chk('BARBEIRO A: NÃO altera a loja onde trabalha',            false, pg_temp.wr($$update public.shops set nome='x' where id='aaaaaaaa-0000-0000-0000-000000000001'$$));

rollback;  -- nada persiste
-- Procure "FAIL" acima. Nenhum FAIL = matriz de autorização correta.
