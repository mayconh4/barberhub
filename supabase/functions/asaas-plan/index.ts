// Assinatura mensal da plataforma (R$ 59,90) cobrada no cartão via Asaas.
// Ações: subscribe (cria assinatura), status (consulta), cancel (cancela).
const ASAAS_URL = Deno.env.get("ASAAS_ENV") === "prod"
  ? "https://api.asaas.com/v3"
  : "https://api-sandbox.asaas.com/v3";
const KEY = Deno.env.get("ASAAS_API_KEY")!;
const PLAN_VALUE = 59.90;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ADMIN_EMAIL = "maycontuliofs@gmail.com";

// Identidade do chamador com o JWT VERIFICADO pelo Auth do Supabase.
// (Antes: atob() decodificava sem checar a assinatura -> qualquer um forjava
//  { email: admin }. Agora o /auth/v1/user valida assinatura e expiração.)
async function verifiedCaller(req: Request): Promise<{ id: string; email: string } | null> {
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const su = Deno.env.get("SUPABASE_URL")!;
    const apikey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const r = await fetch(`${su}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { id: u.id, email: String(u.email || "").toLowerCase() } : null;
  } catch { return null; }
}

// O chamador é dono desta loja? (checado no banco, nunca por id do front)
async function ownsShop(shopId: string, callerId: string): Promise<boolean> {
  try {
    const su = Deno.env.get("SUPABASE_URL")!;
    const sk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const rows = await (await fetch(`${su}/rest/v1/shops?id=eq.${shopId}&select=owner_id`, {
      headers: { apikey: sk, Authorization: `Bearer ${sk}` },
    })).json();
    return !!rows[0] && rows[0].owner_id === callerId;
  } catch { return false; }
}
async function setPlano(shopId: string, planoId: string | null): Promise<void> {
  const su = Deno.env.get("SUPABASE_URL")!;
  const sk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  await fetch(`${su}/rest/v1/shops?id=eq.${shopId}`, {
    method: "PATCH",
    headers: { apikey: sk, Authorization: `Bearer ${sk}`, "Content-Type": "application/json" },
    body: JSON.stringify({ plano_id: planoId }),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const h = { "Content-Type": "application/json", access_token: KEY };

    // resolve link curto do Google Maps (maps.app.goo.gl) até a URL completa com coordenadas
    if (body.action === "maps-resolve") {
      const OK_HOSTS = ["maps.app.goo.gl", "goo.gl", "g.co", "maps.google.com", "www.google.com", "google.com", "maps.googleapis.com", "www.google.com.br", "google.com.br"];
      let url = String(body.url || "").trim();
      for (let i = 0; i < 6; i++) {
        let host = "";
        try { host = new URL(url).hostname.toLowerCase(); } catch { return json({ error: "url inválida" }, 400); }
        if (!OK_HOSTS.some((h2) => host === h2)) return json({ error: "domínio não permitido" }, 400);
        const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
        const loc = r.headers.get("location");
        if (loc) { url = new URL(loc, url).href; continue; }
        // sem redirect: procura coordenadas no corpo da página como último recurso
        const texto = await r.text();
        const m = /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(url) || /(-?\d{1,2}\.\d{4,}),(-?\d{1,3}\.\d{4,})/.exec(texto);
        return json({ finalUrl: url, lat: m ? +m[1] : null, lng: m ? +m[2] : null });
      }
      return json({ finalUrl: url });
    }

    // cria a subconta Asaas de uma barbearia (split de pagamentos) — só admin
    if (body.action === "subconta") {
      const caller = await verifiedCaller(req);
      if (!caller || caller.email !== ADMIN_EMAIL) return json({ error: "acesso restrito" }, 403);
      const su = Deno.env.get("SUPABASE_URL")!;
      const sk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sbH = { apikey: sk, Authorization: `Bearer ${sk}`, "Content-Type": "application/json" };
      const rows = await (await fetch(`${su}/rest/v1/shops?id=eq.${body.shopId}&select=*`, { headers: sbH })).json();
      const shop = rows[0];
      if (!shop) return json({ error: "barbearia não encontrada" }, 404);
      if (shop.asaas_wallet) return json({ walletId: shop.asaas_wallet, jaExistia: true });
      const doc = String(shop.cpf_cnpj || "").replace(/\D/g, "");
      const conta = await (await fetch(`${ASAAS_URL}/accounts`, {
        method: "POST", headers: h,
        body: JSON.stringify({
          name: shop.nome, email: shop.email, cpfCnpj: doc,
          ...(doc.length > 11 ? { companyType: shop.tipo_empresa === "MEI" ? "MEI" : "LIMITED" } : { birthDate: shop.nascimento || "1990-01-01" }),
          mobilePhone: String(shop.telefone || "").replace(/\D/g, ""),
          incomeValue: Number(shop.faturamento) || 5000,
          address: shop.logradouro || "Rua sem nome", addressNumber: String(shop.numero || "s/n"),
          province: shop.bairro || "Centro", postalCode: String(shop.cep || "").replace(/\D/g, ""),
        }),
      })).json();
      const walletId = conta.walletId || (conta.wallets && conta.wallets[0] && conta.wallets[0].id);
      if (!walletId) return json({ error: JSON.stringify(conta.errors || conta) }, 500);
      await fetch(`${su}/rest/v1/shops?id=eq.${body.shopId}`, {
        method: "PATCH", headers: sbH, body: JSON.stringify({ asaas_wallet: walletId }),
      });
      return json({ walletId });
    }

    // visão administrativa: pagamentos e assinaturas de toda a plataforma
    if (body.action === "admin-overview") {
      const caller = await verifiedCaller(req);
      if (!caller || caller.email !== ADMIN_EMAIL) return json({ error: "acesso restrito" }, 403);
      const [pays, subs] = await Promise.all([
        fetch(`${ASAAS_URL}/payments?limit=100&offset=0`, { headers: h }).then((r) => r.json()),
        fetch(`${ASAAS_URL}/subscriptions?limit=100&offset=0`, { headers: h }).then((r) => r.json()),
      ]);
      return json({
        payments: (pays.data || []).map((p: any) => ({
          id: p.id, value: p.value, netValue: p.netValue, status: p.status,
          date: p.paymentDate || p.dueDate, desc: p.description || "", type: p.billingType,
        })),
        subs: (subs.data || []).map((s: any) => ({
          id: s.id, value: s.value, status: s.status, nextDue: s.nextDueDate, desc: s.description || "",
        })),
      });
    }

    if (body.action === "status") {
      const s = await (await fetch(`${ASAAS_URL}/subscriptions/${body.subscriptionId}`, { headers: h })).json();
      return json({ status: s.status || "UNKNOWN", deleted: !!s.deleted });
    }

    if (body.action === "cancel") {
      // só o dono da loja (ou admin) cancela o plano DELA — e o plano_id é zerado aqui
      const caller = await verifiedCaller(req);
      if (!caller) return json({ error: "não autenticado" }, 401);
      const shopId = String(body.shopId || "");
      if (caller.email !== ADMIN_EMAIL && !(await ownsShop(shopId, caller.id))) {
        return json({ error: "acesso restrito" }, 403);
      }
      const s = await (await fetch(`${ASAAS_URL}/subscriptions/${body.subscriptionId}`, { method: "DELETE", headers: h })).json();
      if (shopId) await setPlano(shopId, null);
      return json({ deleted: !!s.deleted });
    }

    // subscribe — só o dono da loja assina o plano DELA
    const caller = await verifiedCaller(req);
    if (!caller) return json({ error: "não autenticado" }, 401);
    const shopId = String(body.shopId || "");
    if (!shopId || !(await ownsShop(shopId, caller.id))) return json({ error: "acesso restrito" }, 403);
    const { nome, email, cpfCnpj, phone, postalCode, addressNumber, card } = body;
    const doc = String(cpfCnpj || "").replace(/\D/g, "");
    const fone = String(phone || "").replace(/\D/g, "");

    // cliente do dono da barbearia (cria ou reaproveita)
    const busca = await (await fetch(`${ASAAS_URL}/customers?cpfCnpj=${doc}`, { headers: h })).json();
    let customerId = busca.data?.[0]?.id;
    if (!customerId) {
      const novo = await (await fetch(`${ASAAS_URL}/customers`, {
        method: "POST", headers: h,
        body: JSON.stringify({ name: nome, cpfCnpj: doc, email, ...(fone ? { mobilePhone: fone } : {}) }),
      })).json();
      if (!novo.id) throw new Error(JSON.stringify(novo.errors || novo));
      customerId = novo.id;
    }

    // assinatura mensal no cartão; o Asaas tokeniza e cobra todo mês sozinho
    const sub = await (await fetch(`${ASAAS_URL}/subscriptions`, {
      method: "POST", headers: h,
      body: JSON.stringify({
        customer: customerId,
        billingType: "CREDIT_CARD",
        value: PLAN_VALUE,
        nextDueDate: new Date().toISOString().slice(0, 10),
        cycle: "MONTHLY",
        description: "Plano SeuBarba — uso da plataforma",
        creditCard: {
          holderName: card.holderName,
          number: String(card.number || "").replace(/\D/g, ""),
          expiryMonth: card.expiryMonth,
          expiryYear: card.expiryYear,
          ccv: card.ccv,
        },
        creditCardHolderInfo: {
          name: nome, email, cpfCnpj: doc,
          postalCode: String(postalCode || "").replace(/\D/g, ""),
          addressNumber: String(addressNumber || "s/n"),
          ...(fone ? { mobilePhone: fone, phone: fone } : {}),
        },
      }),
    })).json();
    if (!sub.id) throw new Error(JSON.stringify(sub.errors || sub));
    // grava o plano na loja com service role (o dono não pode escrever plano_id direto)
    await setPlano(shopId, sub.id);
    return json({ subscriptionId: sub.id, status: sub.status });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
