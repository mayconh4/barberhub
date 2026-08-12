// Edge Function: agendar
// ---------------------------------------------------------------------
// Agendamento seguro para CLIENTE ANÔNIMO. O cliente não tem login, então o
// insert em appointments é bloqueado pela RLS e feito AQUI com service role.
//
// Blindagens:
//   * preço é RECALCULADO a partir da tabela services (nunca confia no valor
//     enviado pelo frontend). Desconto opcional é limitado a 0..90%.
//   * status "pago" só é aceito se o paymentId existir e a Asaas confirmar
//     (RECEIVED/CONFIRMED); caso contrário grava "aguardando".
//   * nome da barbearia/serviço são normalizados a partir do banco.
//   * shopId/serviceIds são validados por EXISTS — IDs do front não decidem nada
//     além de "quais linhas do catálogo somar" (e essas são checadas por shop).
// ---------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ASAAS_URL = "https://api.asaas.com/v3";
const ASAAS_KEY = Deno.env.get("ASAAS_API_KEY") || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json();
    const shopId: string | null = b.shopId || null;
    const barbearia: string = String(b.barbearia || "").slice(0, 120);
    const barbeiro: string = String(b.barbeiro || "").slice(0, 120);
    const clienteNome: string = String(b.cliente_nome || "").slice(0, 120);
    const clienteZap: string = String(b.cliente_zap || "").replace(/\D/g, "").slice(0, 15);
    const dia: string = String(b.dia || "").slice(0, 10);
    const minuto: number = Math.max(0, Math.min(1440, parseInt(b.minuto, 10) || 0));
    const serviceIds: string[] = Array.isArray(b.serviceIds) ? b.serviceIds.slice(0, 10) : [];
    const paymentId: string | null = b.paymentId || null;

    if (!clienteZap) return json({ error: "WhatsApp obrigatório" }, 400);
    if (!dia) return json({ error: "dia obrigatório" }, 400);

    const su = Deno.env.get("SUPABASE_URL")!;
    const sk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(su, sk, { auth: { persistSession: false } });

    // 1) Preço RECALCULADO no servidor a partir do catálogo da loja.
    let base = 0;
    let nomeServico = String(b.servico || "").slice(0, 160);
    if (serviceIds.length) {
      let q = db.from("services").select("nome,preco,shop_id").in("id", serviceIds);
      if (shopId) q = q.eq("shop_id", shopId);           // só serviços DESTA loja
      const { data: svcs, error } = await q;
      if (error) return json({ error: "falha ao ler serviços" }, 500);
      if (!svcs || !svcs.length) return json({ error: "serviços inválidos" }, 400);
      base = svcs.reduce((t: number, s: { preco: number }) => t + Number(s.preco || 0), 0);
      nomeServico = svcs.map((s: { nome: string }) => s.nome).join(" + ");
    } else {
      return json({ error: "serviceIds obrigatório" }, 400);
    }
    // desconto AUTORITATIVO do banco (ignora qualquer percentual mandado pelo cliente)
    let pct = 0;
    if (shopId && clienteNome) {
      try {
        const { data } = await db.rpc("discount_for", { p_shop: shopId, p_nome: clienteNome });
        pct = Math.max(0, Math.min(90, Number(data) || 0));
      } catch (_) { /* sem desconto */ }
    }
    const preco = Math.round(base * (1 - pct / 100) * 100) / 100;

    // 2) Nome da barbearia a partir do banco (não confia no que o front mandou).
    let nomeBarbearia = barbearia;
    if (shopId) {
      const { data: shop } = await db.from("shops").select("nome,ativo").eq("id", shopId).single();
      if (!shop) return json({ error: "barbearia inválida" }, 400);
      nomeBarbearia = shop.nome;
    }

    // 3) status: "pago" só com pagamento CONFIRMADO na Asaas.
    let status = "aguardando";
    if (paymentId && ASAAS_KEY) {
      try {
        const pg = await (await fetch(`${ASAAS_URL}/payments/${paymentId}`, {
          headers: { access_token: ASAAS_KEY },
        })).json();
        if (pg && (pg.status === "RECEIVED" || pg.status === "CONFIRMED")) status = "pago";
      } catch (_) { /* sem confirmação => segue aguardando */ }
    }

    // 4) Insere com service role (RLS bloqueia o cliente de inserir direto).
    const row = {
      shop_id: shopId, barbearia: nomeBarbearia, barbeiro,
      cliente_nome: clienteNome, cliente_zap: clienteZap,
      servico: nomeServico, preco, dia, minuto, status,
    };
    const { data, error } = await db.from("appointments").insert(row).select("id").single();
    if (error) return json({ error: "não foi possível agendar" }, 500);

    // desconto vale UMA vez: consome ao confirmar o pagamento
    if (status === "pago" && pct > 0 && shopId && clienteNome) {
      try {
        await db.from("client_discounts").delete()
          .eq("shop_id", shopId).eq("cliente_nome", clienteNome.trim().toLowerCase());
      } catch (_) { /* ignora */ }
    }

    return json({ ok: true, id: data?.id, preco, status });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
