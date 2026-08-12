# Segurança — RLS & Autorização (SeuBarba)

Auditoria e correção de **Row Level Security** e **autorização** no Supabase.
Objetivo: um usuário **nunca** acessa/altera/exclui dados de outra barbearia
manipulando IDs, requests ou usando a `anon key` (que é pública — vai embutida
no `index.html`).

> Princípio central: **a autorização nunca depende de IDs enviados pelo frontend**.
> Tudo é decidido por `auth.uid()` / `auth.jwt()` (claims assinados pelo Supabase)
> e por `EXISTS` contra o banco. Operações privilegiadas ficam em **Edge Functions
> autenticadas** (service role).

---

## 1. Diagnóstico (estado anterior)

- App acessa o banco **com a anon key** fazendo `SELECT/INSERT/UPDATE/DELETE`
  direto em `shops`, `services`, `barbers`, `barber_shops`, `appointments`.
- **Autorização 100% no frontend** (`isAdmin()` é um `if` em JS; "dono" é um
  filtro `.eq("owner_id", uid)` que o atacante remove).
- Inferência: **RLS desligada ou permissiva** — qualquer um com a anon key lê/edita
  tudo. Riscos concretos encontrados:
  - trocar `plano_id`/`trial_until` para furar o paywall;
  - **trocar `asaas_wallet` e desviar o split de pagamento**;
  - editar **preço** de serviços de qualquer loja; adulterar o `valor` cobrado;
  - vincular `barbers.email` (sequestro de login);
  - **ler nome + WhatsApp de todos os clientes** de todas as lojas;
  - inserir `appointments` com `status:"pago"` sem pagar.
- Edge Functions: `swift-endpoint` sem autenticação e cobrando o `valor` do cliente;
  `asaas-plan` conferia o admin decodificando o JWT com `atob` **sem validar a
  assinatura** (forjável).

## 2. Modelo de identidade

| Ator | Como é identificado | Acesso |
|---|---|---|
| Cliente | **anônimo** (agenda sem login) | cria agendamento e lê os próprios **só via Edge Function**; disponibilidade via RPC sem PII |
| Dono | `auth.uid() == shops.owner_id` | administra **só a própria** loja/serviços/barbeiros (RLS) |
| Barbeiro | `barbers.email == auth.jwt().email` | vê **só os próprios** agendamentos |
| Admin | `auth.jwt().email == e-mail admin` | ações elevadas **só via Edge Function** com JWT verificado |

Relacionamentos: `auth.users →(owner_id) shops →(shop_id) services`; `shops ↔ barbers`
via `barber_shops`; `appointments →(shop_id) shops`, cliente ligado por `cliente_zap`.

## 3. O que cada tabela passa a permitir

| Tabela | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| **shops** | dono/admin (base); público via `shops_public` (colunas seguras, ativo=true) | dono (`owner_id=auth.uid()`) | dono/admin, **só colunas do negócio** (grant por coluna); `ativo/plano_id/trial_until/asaas_wallet` **só Edge Function** | dono/admin |
| **services** | público (cardápio, sem PII) | dono da loja / admin | dono da loja / admin | dono da loja / admin |
| **barbers** | admin, dono da loja do barbeiro, o próprio; público via `barbers_public` (sem e-mail/telefone) | logado | dono da loja (sem `email`/`user_id` — só Edge Function) | dono da loja / admin |
| **barber_shops** | público (vínculos) | dono da loja | — | dono da loja / admin |
| **appointments** | admin, dono da loja, barbeiro (só os dele) | **ninguém direto** → Edge Function `agendar` | ninguém direto | ninguém direto |

Extras: view `shops_public`, view `barbers_public`, RPC `busy_slots()` (horários
ocupados **sem PII**), funções `is_platform_admin()`, `owns_shop()`, `is_shop_barber()`,
`my_barber_name()`.

## 4. Arquivos

**Criados**
- `supabase/migrations/20260812_rls_security.sql` — RLS, policies, grants por coluna, views, RPC, helpers.
- `supabase/functions/agendar/index.ts` — agendamento anônimo seguro (recalcula preço; valida status na Asaas).
- `supabase/functions/meus-agendamentos/index.ts` — cliente lê os próprios por telefone (service role).
- `supabase/functions/barbearia-admin/index.ts` — login de barbeiro, aprovar/ativar, trial, wallet (JWT verificado).
- `supabase/tests/rls_matrix_test.sql` — matriz de testes (roda e faz rollback).

**Alterados**
- `supabase/functions/asaas-plan/index.ts` — JWT **verificado** (fim do `atob` forjável); `subscribe/cancel` conferem posse da loja e gravam `plano_id` server-side.
- `supabase/functions/swift-endpoint/index.ts` — **valor recalculado do catálogo** (anti-adulteração).
- `docs/index.html` — diretório via `shops_public`/`barbers_public`; disponibilidade via `busy_slots`; agendar/meus-agendamentos/login-de-barbeiro/aprovar/trial/plano via Edge Functions (com JWT do usuário).

## 5. Ordem de rollout (você aplica — eu não tenho acesso ao seu banco)

1. **Deploy das Edge Functions** (senão o app quebra ao aplicar a RLS):
   `supabase functions deploy agendar meus-agendamentos barbearia-admin asaas-plan swift-endpoint`
2. Confirme os secrets: `ASAAS_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`.
3. **Aplique a migration**: `supabase db push` (ou cole `20260812_rls_security.sql` no SQL Editor).
   Rode como `postgres` para as views bypassarem a RLS da base (é o padrão do SQL Editor / db push).
4. **Deploy do frontend** (`docs/index.html`) junto — ele já usa os endpoints novos.
5. Rode `supabase/tests/rls_matrix_test.sql` e confira que **não há "FAIL"**.

## 6. Matriz de testes (resultado esperado)

Verificada por `supabase/tests/rls_matrix_test.sql` (transacional, faz rollback):

| Ator | Ação | Esperado |
|---|---|---|
| **Cliente** | SELECT `shops_public` / `services` / `busy_slots` | ✅ permitido |
| Cliente | SELECT base `shops` / `appointments` (agenda alheia) | ⛔ negado |
| Cliente | INSERT `appointments` / UPDATE `shops`/`services` | ⛔ negado (só via `agendar`) |
| **Dono A** | SELECT/UPDATE própria loja, serviços, agenda | ✅ permitido |
| Dono A | SELECT/UPDATE loja B (outra) | ⛔ negado |
| Dono A | UPDATE `ativo`/`plano_id`/`trial_until`/`asaas_wallet` | ⛔ negado (só Edge Function) |
| Dono A | UPDATE `barbers.email` | ⛔ negado (só Edge Function) |
| **Barbeiro A** | SELECT os próprios agendamentos | ✅ permitido |
| Barbeiro A | SELECT agenda da loja B / base `shops` / UPDATE loja | ⛔ negado |

Testes de integração do frontend (Playwright, rodados no desenvolvimento) confirmam:
disponibilidade sem PII, agendamento pela Edge Function com preço do catálogo,
e "meus agendamentos" pela Edge Function — além da suíte de regressão completa
(card, PIX, login de barbeiro, ordem, ícones, recuperação de senha) sem quebras.

## 7. Riscos residuais / atenção

- **Identidade do cliente é fraca** (telefone). `meus-agendamentos` já não permite
  varrer a tabela inteira, mas quem souber o número vê os agendamentos dele.
  Para robustez: código de verificação por WhatsApp/SMS.
- **Desconto por cliente é local** (localStorage do barbeiro), então o servidor não
  consegue validá-lo — o `descPct` é **limitado a 0–90%** no servidor. Para eliminar,
  mover descontos para uma tabela no banco.
- **`ativo` só sobe por admin**: se hoje algum dono reativava a própria loja sozinho,
  agora precisa do admin (era esse o comportamento indicado na UI).
- Um `barbers` órfão pode ser criado por qualquer logado (sem vínculo, sem poder);
  o poder vem de `barber_shops`, controlado pelo dono. Se incomodar, dá para exigir
  `owns_shop` também no INSERT de `barbers` (via Edge Function).
