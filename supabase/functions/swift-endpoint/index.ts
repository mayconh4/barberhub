// produção fixa (sem sandbox) — cobra de verdade
const ASAAS_URL = "https://api.asaas.com/v3";
const KEY = Deno.env.get("ASAAS_API_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { valor, nome, cpf, whatsapp, email, descricao, paymentId, shopId,
      formaPagamento, card, creditCardToken, holderInfo, serviceIds } = await req.json();
    const h = { "Content-Type": "application/json", access_token: KEY };
    const ehCartao = formaPagamento === "CREDIT_CARD";
    // IP do cliente — a Asaas exige em cobranças no cartão
    const remoteIp = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || undefined;

    // consulta de status: o app chama com { paymentId } até o PIX ser pago
    if (paymentId) {
      const pg = await (await fetch(`${ASAAS_URL}/payments/${paymentId}`, { headers: h })).json();
      return new Response(JSON.stringify({ status: pg.status || "UNKNOWN" }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const doc = String(cpf || "").replace(/\D/g, "");

    // 1) cliente: reaproveita se o CPF já existe, senão cria
    const busca = await (await fetch(`${ASAAS_URL}/customers?cpfCnpj=${doc}`, { headers: h })).json();
    let customerId = busca.data?.[0]?.id;
    if (!customerId) {
      const fone = String(whatsapp || "").replace(/\D/g, "");
      const criar = (comFone: boolean) => fetch(`${ASAAS_URL}/customers`, {
        method: "POST", headers: h,
        body: JSON.stringify({ name: nome, cpfCnpj: doc, ...(email ? { email } : {}), ...(comFone && fone ? { mobilePhone: fone } : {}) }),
      }).then((r) => r.json());
      let novo = await criar(true);
      // telefone rejeitado pelo Asaas? cria sem telefone em vez de travar a venda
      if (!novo.id && JSON.stringify(novo.errors || "").includes("mobilePhone")) novo = await criar(false);
      if (!novo.id) throw new Error(JSON.stringify(novo.errors || novo));
      customerId = novo.id;
    }

    // split: a barbearia (subconta) recebe a parte dela; a comissão fica na conta principal
    let split: unknown[] | undefined;
    if (shopId) {
      try {
        const su = Deno.env.get("SUPABASE_URL")!;
        const sk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const rows = await (await fetch(`${su}/rest/v1/shops?id=eq.${shopId}&select=asaas_wallet`, {
          headers: { apikey: sk, Authorization: `Bearer ${sk}` },
        })).json();
        const wallet = rows[0]?.asaas_wallet;
        if (wallet) {
          const comissao = Number(Deno.env.get("PLATFORM_COMMISSION") || "5"); // % do admin
          split = [{ walletId: wallet, percentualValue: Math.max(0, 100 - comissao) }];
        }
      } catch (_) { /* sem wallet: 100% fica na conta principal */ }
    }

    // valor AUTORITATIVO: preço do catálogo + desconto lido do BANCO. NÃO confia
    // no "valor" nem no "descPct" enviados pelo cliente (anti-adulteração de preço).
    let valorFinal = Number(valor) || 0;
    const ids = (Array.isArray(serviceIds) ? serviceIds : [])
      .filter((x: unknown) => typeof x === "string" && /^[0-9a-fA-F-]{36}$/.test(x));
    if (ids.length && shopId) {
      try {
        const su = Deno.env.get("SUPABASE_URL")!;
        const sk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const sbH = { apikey: sk, Authorization: `Bearer ${sk}`, "Content-Type": "application/json" };
        const svcs = await (await fetch(
          `${su}/rest/v1/services?shop_id=eq.${shopId}&id=in.(${ids.join(",")})&select=preco`,
          { headers: sbH },
        )).json();
        const base = (svcs || []).reduce((t: number, s: { preco: number }) => t + Number(s.preco || 0), 0);
        // desconto do cliente lido do banco (0 se não houver)
        let pct = 0;
        try {
          const dr = await (await fetch(`${su}/rest/v1/rpc/discount_for`, {
            method: "POST", headers: sbH, body: JSON.stringify({ p_shop: shopId, p_nome: nome }),
          })).json();
          pct = Math.max(0, Math.min(90, Number(dr) || 0));
        } catch (_) { /* sem desconto */ }
        if (base > 0) valorFinal = Math.round(base * (1 - pct / 100) * 100) / 100;
      } catch (_) { /* mantém o valor recebido se a consulta falhar */ }
    }

    const hoje = new Date().toISOString().slice(0, 10);

    // 2a) cobrança no CARTÃO (cartão novo ou token salvo) — confirma na hora
    if (ehCartao) {
      const fone = String(whatsapp || "").replace(/\D/g, "");
      const corpo: Record<string, unknown> = {
        customer: customerId, billingType: "CREDIT_CARD", value: valorFinal,
        dueDate: hoje, description: descricao,
        ...(split ? { split } : {}),
        ...(remoteIp ? { remoteIp } : {}),
      };
      if (creditCardToken) {
        // cartão já salvo: cobra pelo token, sem redigitar os dados
        corpo.creditCardToken = creditCardToken;
      } else {
        // cartão novo: a Asaas tokeniza e devolve o token para as próximas
        corpo.creditCard = {
          holderName: card?.holderName || nome,
          number: String(card?.number || "").replace(/\D/g, ""),
          expiryMonth: card?.expiryMonth, expiryYear: card?.expiryYear, ccv: card?.ccv,
        };
        corpo.creditCardHolderInfo = {
          name: nome, email, cpfCnpj: doc,
          postalCode: String(holderInfo?.postalCode || "").replace(/\D/g, ""),
          addressNumber: String(holderInfo?.addressNumber || "s/n"),
          ...(fone ? { mobilePhone: fone, phone: fone } : {}),
        };
      }
      const pg = await (await fetch(`${ASAAS_URL}/payments`, {
        method: "POST", headers: h, body: JSON.stringify(corpo),
      })).json();
      if (!pg.id) throw new Error(JSON.stringify(pg.errors || pg));
      return new Response(JSON.stringify({
        paymentId: pg.id, status: pg.status,
        creditCardToken: pg.creditCard?.creditCardToken,
        last4: pg.creditCard?.creditCardNumber, brand: pg.creditCard?.creditCardBrand,
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // 2b) cobrança PIX com vencimento hoje
    const cob = await (await fetch(`${ASAAS_URL}/payments`, {
      method: "POST", headers: h,
      body: JSON.stringify({
        customer: customerId, billingType: "PIX", value: valorFinal,
        dueDate: hoje, description: descricao,
        ...(split ? { split } : {}),
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
