// swift-endpoint — cobrança PIX/cartão (Asaas) com dinheiro 100% no servidor.
// =====================================================================
// REGRA: o frontend é comprometível. NADA que decida QUANTO se cobra ou PARA
// ONDE vai o dinheiro pode vir do cliente. O cliente manda só IDENTIFICADORES
// (shopId, serviceIds, dia, minuto) e os dados do pagador (nome/cpf/zap/cartão).
//
// Ignorados de propósito (mesmo se vierem no corpo): valor, preço, descPct,
// split, walletId, comissão. Tudo isso é derivado do BANCO.
//
// Proteções:
//  - value SEMPRE = soma dos preços do catálogo (da loja) - desconto do banco.
//  - serviceIds precisam TODOS pertencer à shopId e existir (senão 400).
//  - valor final validado (finito, > 0, <= teto). Rejeita 0.01/negativo/NaN/Infinity.
//  - split/wallet lidos de shops.asaas_wallet (nunca do cliente).
//  - idempotência determinística (payment_intents.idem_key): mesma reserva não
//    gera duas cobranças (anti replay / duplo-clique / retry).
//  - rate limit por telefone (janela de 10 min).
//  - poll de status só aceita paymentId que ESTA função criou.
// =====================================================================
const ASAAS_URL = "https://api.asaas.com/v3";
const KEY = Deno.env.get("ASAAS_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const COMMISSION = Number(Deno.env.get("PLATFORM_COMMISSION") || "5"); // % da plataforma
const MAX_VALUE = Number(Deno.env.get("MAX_CHARGE") || "100000");      // teto de segurança (R$)
const RATE_MAX = Number(Deno.env.get("RATE_MAX") || "8");              // cobranças / 10 min / telefone

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const asaasH = { "Content-Type": "application/json", access_token: KEY };
const sbH = { apikey: SB_SR, Authorization: `Bearer ${SB_SR}`, "Content-Type": "application/json" };
const isUuid = (x: unknown) => typeof x === "string" && /^[0-9a-fA-F-]{36}$/.test(x);
const sb = (path: string, init?: RequestInit) => fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...sbH, ...(init?.headers || {}) } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json();
    const {
      nome, cpf, whatsapp, email, paymentId, shopId,
      formaPagamento, card, creditCardToken, holderInfo, serviceIds, dia, minuto,
    } = b;
    // (valor, preço, descPct, split, walletId vindos do corpo são IGNORADOS de propósito)

    // -------- consulta de status: só de cobranças que NÓS criamos --------
    if (paymentId) {
      if (typeof paymentId !== "string" || paymentId.length > 64) return json({ error: "id inválido" }, 400);
      const rows = await (await sb(`payment_intents?asaas_payment_id=eq.${encodeURIComponent(paymentId)}&select=id`)).json();
      if (!rows || !rows.length) return json({ error: "pagamento não reconhecido" }, 404);
      const pg = await (await fetch(`${ASAAS_URL}/payments/${paymentId}`, { headers: asaasH })).json();
      const status = pg.status || "UNKNOWN";
      await sb(`payment_intents?asaas_payment_id=eq.${encodeURIComponent(paymentId)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      return json({ status });
    }

    // -------- validação dos IDENTIFICADORES (nada financeiro do cliente) --------
    const ehCartao = formaPagamento === "CREDIT_CARD";
    const forma = ehCartao ? "CREDIT_CARD" : "PIX";
    if (!isUuid(shopId)) return json({ error: "loja inválida" }, 400);

    const ids = Array.from(new Set((Array.isArray(serviceIds) ? serviceIds : []).filter(isUuid)));
    if (!ids.length) return json({ error: "serviços obrigatórios" }, 400);

    // 1) loja precisa existir; a carteira do split vem DAQUI (nunca do cliente)
    const shopRows = await (await sb(`shops?id=eq.${shopId}&select=id,asaas_wallet`)).json();
    const shop = shopRows && shopRows[0];
    if (!shop) return json({ error: "loja não encontrada" }, 404);

    // 2) serviços: TODOS têm de existir E pertencer à loja
    const svcs = await (await sb(`services?shop_id=eq.${shopId}&id=in.(${ids.join(",")})&select=id,nome,preco`)).json();
    if (!Array.isArray(svcs) || svcs.length !== ids.length) {
      return json({ error: "serviço inválido para esta loja" }, 400);
    }

    // 3) preço do BANCO + desconto do BANCO
    const base = svcs.reduce((t: number, s: { preco: number }) => t + Number(s.preco || 0), 0);
    let pct = 0;
    try {
      const dr = await (await sb(`rpc/discount_for`, { method: "POST", body: JSON.stringify({ p_shop: shopId, p_nome: nome }) })).json();
      pct = Math.max(0, Math.min(90, Number(dr) || 0));
    } catch (_) { /* sem desconto */ }
    const valorFinal = Math.round(base * (1 - pct / 100) * 100) / 100;

    // 4) VALIDA o valor final (bloqueia 0.01 / negativo / NaN / Infinity / absurdos)
    if (!Number.isFinite(valorFinal) || valorFinal <= 0 || valorFinal > MAX_VALUE) {
      return json({ error: "valor inválido" }, 400);
    }

    // 5) split determinado no SERVIDOR a partir da carteira da loja no banco
    let split: unknown[] | undefined;
    if (shop.asaas_wallet) {
      split = [{ walletId: shop.asaas_wallet, percentualValue: Math.max(0, 100 - COMMISSION) }];
    }

    // 6) descrição derivada do servidor (não confia no texto do cliente)
    const nomeServico = svcs.map((s: { nome: string }) => s.nome).join(" + ");
    const descricao = nomeServico + (pct ? ` (desconto ${pct}%)` : "");

    const zap = String(whatsapp || "").replace(/\D/g, "");
    const doc = String(cpf || "").replace(/\D/g, "");

    // 7) RATE LIMIT por telefone (janela de 10 min)
    if (zap) {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const recent = await (await sb(`payment_intents?cliente_zap=eq.${zap}&created_at=gt.${since}&select=id`)).json();
      if (Array.isArray(recent) && recent.length >= RATE_MAX) return json({ error: "muitas tentativas, aguarde alguns minutos" }, 429);
    }

    // 8) IDEMPOTÊNCIA: chave determinística da reserva. Insere ANTES de cobrar.
    const idem = [shopId, zap, ids.slice().sort().join(","), String(dia || ""), String(minuto || ""), forma].join("|");
    const ins = await sb(`payment_intents`, {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ idem_key: idem, shop_id: shopId, cliente_zap: zap, cpf: doc, forma, valor: valorFinal, status: "creating" }),
    });
    if (ins.status === 409) {
      // já existe uma tentativa para esta reserva -> não cria outra cobrança
      const ex = await (await sb(`payment_intents?idem_key=eq.${encodeURIComponent(idem)}&select=asaas_payment_id,status,forma`)).json();
      const row = ex && ex[0];
      if (row && row.asaas_payment_id) {
        if (row.forma === "PIX") {
          const qr = await (await fetch(`${ASAAS_URL}/payments/${row.asaas_payment_id}/pixQrCode`, { headers: asaasH })).json();
          return json({ paymentId: row.asaas_payment_id, qrImage: qr.encodedImage, copiaECola: qr.payload, status: row.status, duplicate: true });
        }
        return json({ paymentId: row.asaas_payment_id, status: row.status, duplicate: true });
      }
      return json({ error: "cobrança em processamento, tente de novo em instantes" }, 409);
    }
    if (!ins.ok) return json({ error: "falha ao registrar a cobrança" }, 500);

    // -------- a partir daqui a cobrança é única e o valor é do servidor --------
    const remoteIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined;

    // cliente Asaas: reaproveita pelo CPF, senão cria
    const busca = await (await fetch(`${ASAAS_URL}/customers?cpfCnpj=${doc}`, { headers: asaasH })).json();
    let customerId = busca.data?.[0]?.id;
    if (!customerId) {
      const criar = (comFone: boolean) => fetch(`${ASAAS_URL}/customers`, {
        method: "POST", headers: asaasH,
        body: JSON.stringify({ name: nome, cpfCnpj: doc, ...(email ? { email } : {}), ...(comFone && zap ? { mobilePhone: zap } : {}) }),
      }).then((r) => r.json());
      let novo = await criar(true);
      if (!novo.id && JSON.stringify(novo.errors || "").includes("mobilePhone")) novo = await criar(false);
      if (!novo.id) { await marcarErro(idem); return json({ error: "não foi possível criar o cliente" }, 502); }
      customerId = novo.id;
    }

    const hoje = new Date().toISOString().slice(0, 10);

    // CARTÃO
    if (ehCartao) {
      const corpo: Record<string, unknown> = {
        customer: customerId, billingType: "CREDIT_CARD", value: valorFinal,
        dueDate: hoje, description: descricao,
        ...(split ? { split } : {}),
        ...(remoteIp ? { remoteIp } : {}),
      };
      if (creditCardToken) {
        corpo.creditCardToken = creditCardToken;
      } else {
        corpo.creditCard = {
          holderName: card?.holderName || nome,
          number: String(card?.number || "").replace(/\D/g, ""),
          expiryMonth: card?.expiryMonth, expiryYear: card?.expiryYear, ccv: card?.ccv,
        };
        corpo.creditCardHolderInfo = {
          name: nome, email, cpfCnpj: doc,
          postalCode: String(holderInfo?.postalCode || "").replace(/\D/g, ""),
          addressNumber: String(holderInfo?.addressNumber || "s/n"),
          ...(zap ? { mobilePhone: zap, phone: zap } : {}),
        };
      }
      const pg = await (await fetch(`${ASAAS_URL}/payments`, { method: "POST", headers: asaasH, body: JSON.stringify(corpo) })).json();
      if (!pg.id) { await marcarErro(idem); return json({ error: JSON.stringify(pg.errors || pg) }, 502); }
      await sb(`payment_intents?idem_key=eq.${encodeURIComponent(idem)}`, { method: "PATCH", body: JSON.stringify({ asaas_payment_id: pg.id, status: pg.status }) });
      return json({
        paymentId: pg.id, status: pg.status,
        creditCardToken: pg.creditCard?.creditCardToken,
        last4: pg.creditCard?.creditCardNumber, brand: pg.creditCard?.creditCardBrand,
      });
    }

    // PIX
    const cob = await (await fetch(`${ASAAS_URL}/payments`, {
      method: "POST", headers: asaasH,
      body: JSON.stringify({ customer: customerId, billingType: "PIX", value: valorFinal, dueDate: hoje, description: descricao, ...(split ? { split } : {}) }),
    })).json();
    if (!cob.id) { await marcarErro(idem); return json({ error: JSON.stringify(cob.errors || cob) }, 502); }
    await sb(`payment_intents?idem_key=eq.${encodeURIComponent(idem)}`, { method: "PATCH", body: JSON.stringify({ asaas_payment_id: cob.id, status: cob.status }) });
    const qr = await (await fetch(`${ASAAS_URL}/payments/${cob.id}/pixQrCode`, { headers: asaasH })).json();
    return json({ paymentId: cob.id, qrImage: qr.encodedImage, copiaECola: qr.payload });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// libera a idem_key se a cobrança falhou (permite o cliente tentar de novo)
async function marcarErro(idem: string) {
  try { await sb(`payment_intents?idem_key=eq.${encodeURIComponent(idem)}`, { method: "DELETE" }); } catch (_) { /* ignora */ }
}
