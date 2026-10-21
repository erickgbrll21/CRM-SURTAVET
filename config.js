// ═══════════════════════════════════════════════════
//  Configuração do Supabase — projeto SURTAVET
//  A chave anon/publishable é pública de propósito
//  (RLS protege os dados por usuário autenticado).
// ═══════════════════════════════════════════════════
window.SUPABASE_CONFIG = {
  url: 'https://gjngycfcqrpsuyeexcyn.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqbmd5Y2ZjcXJwc3V5ZWV4Y3luIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2NDU0NjcsImV4cCI6MjEwNTIyMTQ2N30.2CVbG_UNh3nEpDuS30tG90snZaHoyzRE7HhipuRdHuI',
  allowSignup: false, // contas só são criadas por um administrador
  allowLocalFallback: false,
  // Edge Function: defina o secret ALLOWED_ORIGINS com o domínio de produção
  // (ex: https://seu-app.vercel.app). Localhost já é liberado na função.
  // Client ID OAuth do Google Cloud (tipo Aplicativo da Web). Não cole o client secret aqui.
  googleClientId: '904718882040-ru6ccqsvjoam4s4fpudqujs5d2e96jff.apps.googleusercontent.com'
};
