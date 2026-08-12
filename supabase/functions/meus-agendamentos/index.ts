// Edge Function: meus-agendamentos
// ---------------------------------------------------------------------
// Cliente anônimo consulta os PRÓPRIOS agendamentos pelo telefone.
// A RLS bloqueia SELECT direto em appointments para o cliente (senão dá pra
// varrer a agenda de todo mundo). Aqui devolvemos SÓ as linhas do telefone
// informado, com service role, e apenas as colunas necessárias.
//
// Observação de segurança: telefone é uma identidade FRACA (quem souber o número
// vê os agendamentos dele). É melhor que a exposição atual (tabela inteira), mas
// para robustez futura considere um código de verificação por SMS/WhatsApp.
// ---------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json();
    const zap = String(b.cliente_zap || "").replace(/\D/g, "").slice(0, 15);
    if (zap.length < 8) return json({ error: "telefone inválido" }, 400);

    const su = Deno.env.get("SUPABASE_URL")!;
    const sk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(su, sk, { auth: { persistSession: false } });

    const { data, error } = await db
      .from("appointments")
      .select("id, shop_id, barbearia, barbeiro, servico, preco, dia, minuto, status")
      .eq("cliente_zap", zap)
      .order("dia", { ascending: false });
    if (error) return json({ error: "falha ao buscar" }, 500);

    return json({ ok: true, appointments: data || [] });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
