import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const LOCAL_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173",
  "http://localhost:5500",
  "http://localhost:8080",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5500",
  "http://127.0.0.1:8080",
];

const hits = new Map<string, { n: number; t: number }>();

function allowedOrigins(): string[] {
  const extra = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...LOCAL_ORIGINS, ...extra];
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return true;
  if (allowedOrigins().includes(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && u.hostname.endsWith(".vercel.app");
  } catch {
    return false;
  }
}

function corsHeaders(origin: string): Record<string, string> {
  const allow = origin && isAllowedOrigin(origin) ? origin : allowedOrigins()[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(origin: string, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const row = hits.get(ip);
  if (!row || now - row.t > 10 * 60 * 1000) {
    hits.set(ip, { n: 1, t: now });
    return false;
  }
  row.n += 1;
  return row.n > 10;
}

function validEmail(email: string): boolean {
  return email.length > 3 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    if (origin && !isAllowedOrigin(origin)) {
      return new Response("Origin negada", { status: 403 });
    }
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") return json(origin, { error: "Método não permitido." }, 405);
  if (origin && !isAllowedOrigin(origin)) return json(origin, { error: "Origin negada." }, 403);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) return json(origin, { error: "Muitas tentativas. Aguarde um momento." }, 429);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json(origin, { error: "Servidor sem credenciais." }, 500);

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const { count, error: countError } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true });
  if (countError) return json(origin, { error: "Falha ao consultar o servidor." }, 500);

  if (body.action === "status") {
    return json(origin, { needsBootstrap: !count });
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim().slice(0, 120);
  const role = body.role === "admin" ? "admin" : "user";

  if (!validEmail(email)) return json(origin, { error: "E-mail inválido." }, 400);
  if (password.length < 12) return json(origin, { error: "A senha precisa ter pelo menos 12 caracteres." }, 400);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.split(".").length < 3) {
    return json(origin, { error: "Não autenticado. Crie o primeiro admin em Authentication → Users no painel do Supabase." }, 401);
  }
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return json(origin, { error: "Sessão inválida." }, 401);
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (profile?.role !== "admin") {
    return json(origin, { error: "Apenas administradores podem criar contas." }, 403);
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
    app_metadata: { role },
  });
  if (error) {
    const msg = (error.message || "").toLowerCase();
    if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
      return json(origin, { error: "Este e-mail já está cadastrado." }, 400);
    }
    return json(origin, { error: "Não foi possível criar a conta." }, 400);
  }

  if (data.user) {
    await supabase.from("profiles").upsert({
      id: data.user.id,
      email,
      name,
      role,
    });
  }

  return json(origin, {
    ok: true,
    user: { id: data.user?.id, email, name, role },
  });
});
