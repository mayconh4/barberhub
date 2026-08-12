# Segurança do fluxo de pagamento (SeuBarba)

Auditoria e correção do fluxo de cobrança. **Regra:** o frontend é comprometível;
nada que decida **quanto** se cobra ou **para onde** vai o dinheiro pode vir do
cliente. O cliente manda só **identificadores** (`shopId`, `serviceIds`, `dia`,
`minuto`) e os dados do pagador (nome/CPF/WhatsApp/cartão).

## Endpoints financeiros
- `swift-endpoint` — cobrança PIX/cartão (Asaas). **Reescrito.**
- `asaas-plan` — assinatura do plano da plataforma. Já estava correto: valor é
  a constante `PLAN_VALUE` (R$ 59,90), JWT **verificado** (`auth.getUser`),
  posse da loja conferida, `plano_id` gravado server-side.
- `agendar` — registra o agendamento pago (não é cobrança). Recalcula preço do
  catálogo, exige que **todos** os `serviceIds` pertençam à loja, e só grava
  `status:"pago"` com pagamento **confirmado na Asaas**.

## Desenho de autenticação (importante)
O agendamento do cliente é **anônimo** (ele não faz login) — decisão de produto.
Logo, não há JWT de usuário no pagamento. A defesa **não** é "exigir login"; é:
**valor/split/carteira/desconto 100% derivados do banco + idempotência + rate limit
+ validação de identificadores**. Onde há usuário logado (dono, em `asaas-plan`),
o JWT é verificado de verdade.

## Respostas ao checklist

| # | Pergunta | Situação |
|---|---|---|
| 1 | Edge Function exige JWT válido? | Anon (mín. anon key). Pagamento é anônimo por design; defesa é server-side (abaixo). `asaas-plan` exige JWT verificado. |
| 2 | Usuário identificado pelo JWT? | Pagamento anônimo: N/A. `asaas-plan`: sim (`auth.getUser`). |
| 3 | Autorização? | `asaas-plan`: só o dono da loja. Pagamento: qualquer um paga a própria reserva (não há o que autorizar). |
| 4 | serviceId pertence à shopId? | **Sim** — rejeita `serviço inválido para esta loja`. |
| 5 | Serviço existe? | **Sim** — exige que **todos** os ids existam (count == ids). |
| 6 | Preço do banco? | **Sim** — `services.preco`. |
| 7 | Valor final só no servidor? | **Sim** — sem fallback para o `valor` do cliente. |
| 8 | Descontos validados no servidor? | **Sim** — `client_discounts` / `discount_for`. |
| 9 | Split determinado pelo servidor? | **Sim** — `100 - PLATFORM_COMMISSION`. |
| 10 | Carteira de fonte confiável? | **Sim** — `shops.asaas_wallet` (banco). |
| 11 | Dá pra manipular shopId? | Bloqueado: loja inexistente/inválida → 400/404; o dinheiro só vai para a loja escolhida (a carteira é a dela, do banco). |
| 12 | Dá pra manipular serviceId? | **Bloqueado** (pertence-à-loja + existe). |
| 13 | valor = 0.01? | **Ignorado** — cobra o preço do banco. |
| 14 | valor negativo? | **Ignorado**. |
| 15 | NaN/Infinity/inválido? | **Ignorado** (valor vem do banco) + validação `finito, >0, <= teto`. |
| 16 | Cobranças em massa? | **Rate limit** por telefone (8 / 10 min). |
| 17 | Replay? | **Idempotência determinística** (mesma reserva → mesma cobrança). |
| 18 | Idempotência? | **Sim** — `payment_intents.idem_key` único. |
| 19 | Múltiplas cobranças p/ o mesmo agendamento? | **Bloqueado** — `idem_key = shop|zap|serviços|dia|minuto|forma`. |
| 20 | Status confiável? | Vem da **Asaas**, nunca do cliente; o poll só aceita `paymentId` que criamos; `agendar` só marca "pago" com confirmação da Asaas. |

## O que a Edge Function faz agora (swift-endpoint)
1. valida os identificadores (shopId UUID, serviceIds UUID);
2. confirma que a **loja existe** (e pega a carteira do split do banco);
3. confirma que **todos** os serviços existem e são **da loja**;
4. **preço do banco** + **desconto do banco**;
5. **valida** o valor final (finito, > 0, ≤ teto) — bloqueia 0.01/negativo/NaN/Infinity;
6. **split/carteira do servidor** (nunca do cliente);
7. **idempotência**: registra `payment_intents` antes de cobrar; reserva repetida
   devolve a mesma cobrança (não cria outra);
8. **rate limit** por telefone;
9. cria a cobrança na Asaas com o valor do servidor;
10. devolve ao frontend só o necessário (paymentId, QR, status).

Nunca mais existe `value: valor` com `valor` vindo do cliente.

## Ataques testados e bloqueados (`pay-attacks`)
| Ataque | Resultado |
|---|---|
| `valor = 0.01` / negativo / string | **Ignorado** — cobra R$45 (banco) |
| `descPct = 90` (desconto forjado) | **Ignorado** — desconto só do banco |
| `split`/`walletId` do atacante | **Ignorados** — usa `shops.asaas_wallet` |
| `shopId` inexistente / inválido | **Bloqueado** (404/400) |
| `serviceId` de outra loja / inexistente | **Bloqueado** (400) |
| Mesma reserva 2× (duplicidade) | **Idempotente** — 1 cobrança, mesmo paymentId |
| Criação em massa (mesmo telefone) | **Rate limit** — 9ª bloqueada |
| Poll de `paymentId` desconhecido | **Bloqueado** (anti-enumeração) |

## Arquivos
- `supabase/migrations/20260814_payment_intents.sql` (nova tabela, só service role).
- `supabase/functions/swift-endpoint/index.ts` (reescrito).
- `supabase/functions/agendar/index.ts` (serviços obrigatoriamente da loja).
- `docs/index.html` (envia só identificadores + `dia`/`minuto`; não envia mais valor/desconto).

## Rollout
`supabase functions deploy swift-endpoint agendar` → `supabase db push` (aplica
`20260814_payment_intents.sql`) → deploy do frontend. Envs opcionais:
`PLATFORM_COMMISSION` (%), `MAX_CHARGE` (teto), `RATE_MAX` (limite/10 min).

## Ponto de atenção residual
O CPF do pagador ainda é informado pelo cliente (inerente a pagamento anônimo);
não determina valor nem destino, mas identifica o cliente Asaas. Para KYC forte,
seria preciso verificação de identidade — fora do escopo deste fluxo.
