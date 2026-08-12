// Edge Function: meus-agendamentos
// ---------------------------------------------------------------------
// Cliente anônimo consulta os PRÓPRIOS agendamentos pelo telefone.
// A RLS bloqueia SELECT direto em appointments (senão dá pra varrer a agenda
// de todo mundo). Aqui devolvemos SÓ as linhas do telefone informado, com
// service role, e apenas as colunas necessárias.
//
// Telefone é identidade FRACA (BOLA): quem souber o número vê os agendamentos.
// Mitigação: RATE LIMIT por IP (contém enumeração em massa). Correção completa =
// código de verificação por WhatsApp/SMS antes de devolver os dados (OTP).
// ---------------------------------------------------------------------
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOW = ["https://seubarba.app", "https://www.seubarba.app", "https://mayconh4.github.io", "http://localhost:8123"];
function corsFor(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOW.includes(origin) ? origin : ALLOW[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const MAX_BODY = 16 * 1024;   // 16 KB
const LOOKUP_MAX = 20;        // consultas por IP / 10 min

Deno.serve(async (req) => {
  const CO = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CO });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CO, "Content-Type": "application/json" } });
  try {
    if (Number(req.headers.get("content-length") || "0") > MAX_BODY) return json({ error: "requisição muito grande" }, 413);
    const txt = await req.text();
    if (txt.length > MAX_BODY) return json({ error: "requisição muito grande" }, 413);
    let b: any = {};
    try { b = JSON.parse(txt || "{}"); } catch { return json({ error: "json inválido" }, 400); }

    const zap = String(b.cliente_zap || "").replace(/\D/g, "").slice(0, 15);
    if (zap.length < 8) return json({ error: "telefone inválido" }, 400);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // rate limit por IP (contém enumeração de telefones)
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    if (ip) {
      const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: recent } = await db.from("access_throttle").select("id").eq("scope", "meus-agendamentos").eq("ip", ip).gt("created_at", since);
      if (Array.isArray(recent) && recent.length >= LOOKUP_MAX) return json({ error: "muitas consultas, aguarde alguns minutos" }, 429);
      await db.from("access_throttle").insert({ scope: "meus-agendamentos", ip });
    }

    const { data, error } = await db
      .from("appointments")
      .select("id, shop_id, barbearia, barbeiro, servico, preco, dia, minuto, status")
      .eq("cliente_zap", zap)
      .order("dia", { ascending: false });
    if (error) { console.error("meus-agendamentos db:", error.message); return json({ error: "falha ao buscar" }, 500); }

    return json({ ok: true, appointments: data || [] });
  } catch (e) {
    console.error("meus-agendamentos:", e);
    return json({ error: "erro interno" }, 500);
  }
});
