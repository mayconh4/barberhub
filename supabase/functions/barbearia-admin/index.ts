// Edge Function: barbearia-admin
// ---------------------------------------------------------------------
// Operações PRIVILEGIADAS que não podem ficar no frontend nem em colunas
// abertas por RLS. O JWT do chamador é VERIFICADO de verdade (auth.getUser),
// não apenas decodificado — então não dá para forjar "email: admin".
//
// Ações:
//   create-barber-login  -> dono da loja (ou admin) cria o acesso de um barbeiro:
//                           cria o usuário no Auth e grava barbers.email/user_id.
//   set-active           -> aprovar (ativo=true) é SÓ admin; desativar (false) o
//                           dono pode na própria loja.
//   set-trial            -> admin: define/zera trial_until.
//   set-wallet           -> admin: define asaas_wallet (subconta do split).
//
// Nada aqui confia em IDs do front para autorizar: a permissão é sempre checada
// contra o banco (owner_id == caller) ou contra o e-mail admin do JWT verificado.
// ---------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAIL = "maycontuliofs@gmail.com";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const su = Deno.env.get("SUPABASE_URL")!;
    const sk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(su, sk, { auth: { persistSession: false } });

    // ---- identidade do chamador: JWT VERIFICADO ----
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: userData } = await db.auth.getUser(token);
    const caller = userData?.user;
    if (!caller) return json({ error: "não autenticado" }, 401);
    const callerEmail = String(caller.email || "").toLowerCase();
    const isAdmin = callerEmail === ADMIN_EMAIL;

    const b = await req.json();
    const action = String(b.action || "");

    const ownsShop = async (shopId: string) => {
      if (!shopId) return false;
      const { data } = await db.from("shops").select("owner_id").eq("id", shopId).single();
      return !!data && data.owner_id === caller.id;
    };
    // dono da loja onde o barbeiro atua?
    const ownsBarber = async (barberId: string) => {
      const { data } = await db
        .from("barber_shops")
        .select("shop_id, shops!inner(owner_id)")
        .eq("barber_id", barberId);
      return !!(data || []).some((r: { shops?: { owner_id?: string } }) => r.shops?.owner_id === caller.id);
    };

    if (action === "create-barber-login") {
      const barberId = String(b.barberId || "");
      const email = String(b.email || "").trim().toLowerCase();
      const password = String(b.password || "");
      if (!barberId || !email || password.length < 6) return json({ error: "dados incompletos" }, 400);
      if (!isAdmin && !(await ownsBarber(barberId))) return json({ error: "acesso restrito" }, 403);

      const { data: created, error: cErr } = await db.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      // se o usuário já existe, seguimos e só vinculamos o e-mail ao barbeiro
      let uid = created?.user?.id;
      if (cErr && !uid) {
        const { data: list } = await db.auth.admin.listUsers();
        uid = list?.users?.find((u) => (u.email || "").toLowerCase() === email)?.id;
        if (!uid) return json({ error: "não foi possível criar o login" }, 400);
      }
      const { error: uErr } = await db.from("barbers").update({ email, user_id: uid }).eq("id", barberId);
      if (uErr) return json({ error: "não foi possível vincular o login" }, 500);
      return json({ ok: true, email });
    }

    if (action === "set-active") {
      const shopId = String(b.shopId || "");
      const ativo = !!b.ativo;
      // aprovar (true) é só admin; desativar (false) o dono pode na própria loja
      const allowed = isAdmin || (!ativo && (await ownsShop(shopId)));
      if (!allowed) return json({ error: "acesso restrito" }, 403);
      const { error } = await db.from("shops").update({ ativo }).eq("id", shopId);
      if (error) return json({ error: "falha ao atualizar" }, 500);
      return json({ ok: true, ativo });
    }

    if (action === "set-trial") {
      if (!isAdmin) return json({ error: "acesso restrito" }, 403);
      const shopId = String(b.shopId || "");
      const trial = b.trial_until ? String(b.trial_until).slice(0, 10) : null;
      const { error } = await db.from("shops").update({ trial_until: trial }).eq("id", shopId);
      if (error) return json({ error: "falha ao atualizar" }, 500);
      return json({ ok: true, trial_until: trial });
    }

    if (action === "set-wallet") {
      if (!isAdmin) return json({ error: "acesso restrito" }, 403);
      const shopId = String(b.shopId || "");
      const wallet = String(b.asaas_wallet || "").slice(0, 120) || null;
      const { error } = await db.from("shops").update({ asaas_wallet: wallet }).eq("id", shopId);
      if (error) return json({ error: "falha ao atualizar" }, 500);
      return json({ ok: true });
    }

    return json({ error: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
