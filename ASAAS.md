# PIX com Asaas — passo a passo (SeuBarba)

O site chama a Edge Function `swift-endpoint` no Supabase, que fala com o Asaas e
devolve `{ qrImage, copiaECola, paymentId }`. Este guia cobre da criação da conta
até o PIX funcionando.

---

## 1. Criar a conta Asaas

**Para testar (recomendado começar aqui):**
1. Acesse https://sandbox.asaas.com e crie uma conta de testes (e-mail e senha).
   O sandbox é grátis, sem burocracia, e nenhum dinheiro real circula.

**Para receber de verdade (produção):**
1. Acesse https://www.asaas.com → **Criar conta**.
2. Informe e-mail, CPF ou CNPJ (MEI serve) e os dados do negócio.
3. Envie os documentos pedidos (identidade + comprovante). A aprovação
   normalmente sai em até 1 dia útil — só depois dela você pode receber PIX real.

## 2. Pegar a API Key

1. Logado no Asaas (sandbox ou produção): **menu do perfil → Integrações → API**
   (ou engrenagem ⚙ → Integrações).
2. Clique em **Gerar API Key** e copie a chave (começa com `$aact_`).
3. Guarde em local seguro — ela dá acesso total à conta. Nunca coloque essa
   chave no site (`index.html`); ela vive só na Edge Function.

## 3. Preparar o Supabase CLI

```bash
npm install -g supabase
supabase login                                  # abre o navegador
supabase link --project-ref xprofyturjjhzjjjvgca # projeto do SeuBarba
```

## 4. Criar a Edge Function

```bash
supabase functions new swift-endpoint
```

Substitua o conteúdo de `supabase/functions/swift-endpoint/index.ts` por:

```ts
const ASAAS_URL = Deno.env.get("ASAAS_ENV") === "prod"
  ? "https://api.asaas.com/v3"
  : "https://api-sandbox.asaas.com/v3";
const KEY = Deno.env.get("ASAAS_API_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { valor, nome, cpf, whatsapp, descricao } = await req.json();
    const h = { "Content-Type": "application/json", access_token: KEY };
    const doc = String(cpf || "").replace(/\D/g, "");

    // 1) cliente: reaproveita se o CPF já existe, senão cria
    const busca = await (await fetch(`${ASAAS_URL}/customers?cpfCnpj=${doc}`, { headers: h })).json();
    let customerId = busca.data?.[0]?.id;
    if (!customerId) {
      const novo = await (await fetch(`${ASAAS_URL}/customers`, {
        method: "POST", headers: h,
        body: JSON.stringify({ name: nome, cpfCnpj: doc, mobilePhone: String(whatsapp || "").replace(/\D/g, "") }),
      })).json();
      if (!novo.id) throw new Error(JSON.stringify(novo.errors || novo));
      customerId = novo.id;
    }

    // 2) cobrança PIX com vencimento hoje
    const cob = await (await fetch(`${ASAAS_URL}/payments`, {
      method: "POST", headers: h,
      body: JSON.stringify({
        customer: customerId, billingType: "PIX", value: valor,
        dueDate: new Date().toISOString().slice(0, 10), description: descricao,
      }),
    })).json();
    if (!cob.id) throw new Error(JSON.stringify(cob.errors || cob));

    // 3) QR Code + copia e cola
    const qr = await (await fetch(`${ASAAS_URL}/payments/${cob.id}/pixQrCode`, { headers: h })).json();

    return new Response(
      JSON.stringify({ paymentId: cob.id, qrImage: qr.encodedImage, copiaECola: qr.payload }),
      { headers: { ...cors, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
```

## 5. Configurar a chave e publicar

```bash
# chave do SANDBOX para testar:
supabase secrets set ASAAS_API_KEY='$aact_SUA_CHAVE_AQUI'
supabase functions deploy swift-endpoint
```

## 6. Testar

Abra o seubarba.app, faça um agendamento e gere o PIX — o QR Code real do
sandbox deve aparecer no lugar do simulado. Ou teste por terminal:

```bash
curl -X POST 'https://xprofyturjjhzjjjvgca.supabase.co/functions/v1/swift-endpoint' \
  -H 'Authorization: Bearer SB_PUBLISHABLE_KEY' -H 'Content-Type: application/json' \
  -d '{"valor":1,"nome":"Teste","cpf":"12345678909","whatsapp":"11999999999","descricao":"Corte teste"}'
```

No painel do sandbox (Cobranças) você pode **simular o pagamento** da cobrança
criada e ver o fluxo completo.

## 7. Ir para produção

Quando a conta real do Asaas estiver aprovada:

```bash
supabase secrets set ASAAS_API_KEY='$aact_CHAVE_DE_PRODUCAO'
supabase secrets set ASAAS_ENV='prod'
supabase functions deploy swift-endpoint
```

Pronto — o mesmo site passa a cobrar PIX de verdade, sem mudar nada no front.

## 8. (Opcional, próximo passo) Webhook de confirmação

Hoje o cliente toca em "Já paguei". Para confirmar automaticamente:
1. No Asaas: **Integrações → Webhooks → Adicionar**, evento
   `PAYMENT_RECEIVED`, apontando para uma segunda Edge Function
   (ex.: `asaas-webhook`).
2. Essa função marca o agendamento como pago no banco e o Realtime do
   Supabase atualiza a agenda na hora. Peça que eu gere essa função quando
   quiser ativar.

## 9. Cartão de crédito (além do PIX)

O checkout também aceita **cartão**. A mesma `swift-endpoint` já trata isso — o
arquivo `supabase/functions/swift-endpoint/index.ts` deste repositório está
atualizado (não use o trecho simplificado da seção 4, que é só PIX). Basta
publicar de novo:

```bash
supabase functions deploy swift-endpoint
```

Como funciona:
- Quando o app envia `formaPagamento: "CREDIT_CARD"` + `card` + `holderInfo`
  (CEP e número) + `email`, a função cria uma cobrança `billingType: CREDIT_CARD`
  e devolve `{ status, paymentId, creditCardToken, last4, brand }`.
- O app só confirma o agendamento se o `status` vier `CONFIRMED`/`RECEIVED` —
  nunca confirma sem cobrança aprovada.
- **Salvar cartão:** quando o cliente marca "Preenche automático no próximo
  corte", o app guarda só o `creditCardToken` + os 4 últimos dígitos (nunca o
  número completo/CVV). Nas próximas, envia `creditCardToken` e a função cobra
  pelo token, sem redigitar o cartão.

Requisitos da Asaas para cartão: a conta precisa estar **aprovada para cartão**
(em produção) e o cliente informa **e-mail, CEP e número** (exigência da
operadora para o `creditCardHolderInfo`). No sandbox, use os cartões de teste da
Asaas. Sem o deploy desta versão, o botão de cartão mostra "não foi possível
concluir o pagamento no cartão" (e nunca confirma por engano).

## Custos (Asaas, PIX)

- Sandbox: grátis.
- Produção: taxa por PIX recebido (~R$ 1,99 por transação no plano básico;
  confira a tabela vigente em asaas.com/precos).
