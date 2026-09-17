// ═══════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════
const STAGES = [
  { id:'new',         name:'Novo Lead',              color:'#6B7280', icon:'🌱' },
  { id:'qualified',   name:'Lead Qualificado',        color:'#3B82F6', icon:'⭐' },
  { id:'contacted',   name:'Primeiro Contato',        color:'#6366F1', icon:'📤' },
  { id:'followup',    name:'Follow-up',               color:'#8B5CF6', icon:'🔄' },
  { id:'responded',   name:'Respondeu',               color:'#F59E0B', icon:'💬' },
  { id:'meeting',     name:'Reunião Marcada',         color:'#F97316', icon:'📅' },
  { id:'proposal',    name:'Proposta Enviada',        color:'#06B6D4', icon:'📄' },
  { id:'negotiation', name:'Negociação',              color:'#14B8A6', icon:'🤝' },
  { id:'closed',      name:'Cliente Fechado',         color:'#10B981', icon:'🏆' },
  { id:'returning',   name:'Cliente Antigo',          color:'#A855F7', icon:'⭐' },
  { id:'lost',        name:'Perdido',                 color:'#EF4444', icon:'❌' }
];

const QL = { A:'🔥 Hot', B:'😊 Warm', C:'❄️ Cold', D:'🧊 Frozen' };
const QC = { A:'badge-A', B:'badge-B', C:'badge-C', D:'badge-D' };

// ═══════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════
let S = {
  leads: [], tasks: [],
  view: 'dashboard',
  editId: null,
  f: { q:'', stage:'', quality:'', responded:'', sold:'' },
  charts: {}
};

// ═══════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function fmt(d) { if (!d) return '—'; return new Date(d+'T12:00:00').toLocaleDateString('pt-BR'); }
function fmtR(v) { return v ? 'R$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0}) : '—'; }
function stage(id) { return STAGES.find(s=>s.id===id) || STAGES[0]; }

// Converte input de texto para número, suportando formato brasileiro (1.810 = 1810)
function parseMoney(s) {
  if (!s && s !== 0) return 0;
  const str = String(s).trim().replace(/R\$\s*/g,'').trim();
  if (!str) return 0;
  // Formato BR com vírgula decimal: 1.810,50
  if (str.includes(',') && str.includes('.')) {
    return parseFloat(str.replace(/\./g,'').replace(',','.')) || 0;
  }
  // Só vírgula: pode ser decimal (1234,50) — mantém como decimal
  if (str.includes(',')) {
    const parts = str.split(',');
    if (parts[1] && parts[1].length <= 2) return parseFloat(str.replace(',','.')) || 0;
    return parseFloat(str.replace(/,/g,'')) || 0;
  }
  // Só ponto: BR usa ponto como milhar (5.810 = 5810), NÃO como decimal
  // Heurística: se após o ponto houver 3 dígitos exatos = milhar
  if (str.includes('.')) {
    const parts = str.split('.');
    const allThousands = parts.slice(1).every(p => p.length === 3);
    if (allThousands) return parseFloat(str.replace(/\./g,'')) || 0;
    return parseFloat(str) || 0;
  }
  return parseFloat(str) || 0;
}

// Formata valor para exibição no input (sem R$, sem centavos desnecessários)
function fmtValInput(v) {
  if (!v) return '';
  return Number(v).toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:2});
}
function toast(msg, type='') {
  const t = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast '+(type||'');
  el.textContent = (type==='success'?'✅ ':type==='error'?'❌ ':'ℹ️ ') + msg;
  t.appendChild(el);
  setTimeout(()=>el.remove(), 2800);
}

// ═══════════════════════════════════════════════════
//  SUPABASE / AUTH
// ═══════════════════════════════════════════════════
let sb = null;
let currentUser = null;
let currentRole = null;
let currentUserName = '';
let teamUsers = [];
let localOnly = false;
let authMode = 'login';
let appReady = false;
let enterPromise = null;
let cloudTimer = null;
let cloudSaving = false;
let cloudQueued = false;
const pendingDeletes = { leads: new Set(), tasks: new Set() };

function cfg() { return window.SUPABASE_CONFIG || {}; }
function isSupabaseConfigured() {
  const c = cfg();
  return !!(c.url && c.anonKey && c.url.startsWith('https://') && !c.url.includes('SEU_PROJETO') && !c.anonKey.includes('COLE_AQUI') && c.anonKey.length > 20);
}
function isAdmin() { return currentRole === 'admin'; }

async function callAdminFn(payload, useSession) {
  const c = cfg();
  const headers = { 'Content-Type': 'application/json', apikey: c.anonKey };
  if (useSession && sb) {
    const { data: { session } } = await sb.auth.getSession();
    if (session?.access_token) headers.Authorization = 'Bearer ' + session.access_token;
  } else {
    headers.Authorization = 'Bearer ' + c.anonKey;
  }
  const res = await fetch(c.url.replace(/\/$/, '') + '/functions/v1/admin-create-user', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha ao comunicar com o servidor.');
  return data;
}

function updateNavForRole() {
  const item = document.getElementById('nav-users');
  if (item) item.classList.toggle('hidden', !isAdmin());
  const roleEl = document.getElementById('user-role');
  if (roleEl) {
    if (isAdmin()) {
      roleEl.textContent = 'Administrador';
      roleEl.classList.remove('hidden');
    } else {
      roleEl.textContent = '';
      roleEl.classList.add('hidden');
    }
  }
}

async function loadCurrentProfile() {
  currentRole = null;
  currentUserName = '';
  if (!sb || !currentUser?.id || localOnly) {
    updateNavForRole();
    return;
  }
  const { data, error } = await sb.from('profiles').select('role,name,email').eq('id', currentUser.id).maybeSingle();
  if (!error && data) {
    currentRole = data.role || 'user';
    currentUserName = data.name || '';
  }
  updateNavForRole();
  updateUserUI();
}

async function loadTeamUsers() {
  if (!sb || !isAdmin()) { teamUsers = []; return; }
  const { data, error } = await sb.from('profiles').select('id,email,name,role,created_at').order('created_at', { ascending: true });
  if (error) throw error;
  teamUsers = data || [];
}

function emptyToNull(v) { return (v === '' || v == null) ? null : v; }

function toDbLead(l) {
  return {
    id: l.id,
    user_id: currentUser.id,
    name: l.name || '',
    instagram: l.instagram || '',
    phone: l.phone || '',
    company: l.company || '',
    niche: l.niche || '',
    source: l.source || '',
    stage: l.stage || 'new',
    service_type: l.serviceType || '',
    quality: l.quality || 'C',
    first_contact_date: emptyToNull(l.firstContactDate),
    meeting_date: emptyToNull(l.meetingDate),
    proposal_date: emptyToNull(l.proposalDate),
    responded: !!l.responded,
    responded_after_proposal: !!l.respondedAfterProposal,
    sold: !!l.sold,
    contract_value: Number(l.contractValue) || 0,
    next_action: l.nextAction || '',
    objections: l.objections || '',
    notes: l.notes || '',
    history: Array.isArray(l.history) ? l.history : [],
    created_at: (l.createdAt || new Date().toISOString()).toString().slice(0,10)
  };
}
function fromDbLead(r) {
  return {
    id: r.id,
    name: r.name || '',
    instagram: r.instagram || '',
    phone: r.phone || '',
    company: r.company || '',
    niche: r.niche || '',
    source: r.source || '',
    stage: r.stage || 'new',
    serviceType: r.service_type || '',
    quality: r.quality || 'C',
    firstContactDate: r.first_contact_date || '',
    meetingDate: r.meeting_date || '',
    proposalDate: r.proposal_date || '',
    responded: !!r.responded,
    respondedAfterProposal: !!r.responded_after_proposal,
    sold: !!r.sold,
    contractValue: Number(r.contract_value) || 0,
    nextAction: r.next_action || '',
    objections: r.objections || '',
    notes: r.notes || '',
    history: Array.isArray(r.history) ? r.history : [],
    createdAt: r.created_at || ''
  };
}
function toDbTask(t) {
  return {
    id: t.id,
    user_id: currentUser.id,
    lead_id: t.leadId || '',
    title: t.title || '',
    due_date: emptyToNull(t.dueDate),
    priority: t.priority || 'medium',
    done: !!t.done,
    created_at: t.createdAt || new Date().toISOString()
  };
}
function fromDbTask(r) {
  return {
    id: r.id,
    leadId: r.lead_id || '',
    title: r.title || '',
    dueDate: r.due_date || '',
    priority: r.priority || 'medium',
    done: !!r.done,
    createdAt: r.created_at || ''
  };
}

function setAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (!el) return;
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function signupAllowed() {
  return cfg().allowSignup === true;
}

function showAuthAdminNote(visible) {
  const note = document.getElementById('auth-admin-note');
  if (!note) return;
  note.classList.toggle('hidden', !visible);
}

function showAuth(mode) {
  authMode = mode || 'login';
  if (authMode === 'signup' && !signupAllowed()) {
    authMode = 'login';
  }
  const form = document.getElementById('auth-form');
  const setup = document.getElementById('auth-setup');
  const links = document.getElementById('auth-links');
  const sub = document.getElementById('auth-sub');
  const pass2 = document.getElementById('auth-pass2-wrap');
  const passWrap = document.getElementById('auth-pass-wrap');
  const submit = document.getElementById('auth-submit');
  const screen = document.getElementById('auth-screen');
  document.body.classList.add('auth-open');
  screen.classList.remove('hidden');
  setup.classList.add('hidden');
  form.classList.remove('hidden');
  links.classList.remove('hidden');
  passWrap.classList.remove('hidden');
  document.getElementById('auth-email').closest('.form-group').classList.remove('hidden');
  document.getElementById('auth-email').required = true;
  document.getElementById('auth-password').required = true;
  document.getElementById('auth-password2').required = false;
  pass2.classList.add('hidden');
  setAuthError('');
  showAuthAdminNote(false);

  if (authMode === 'bootstrap') {
    sub.textContent = 'Crie o primeiro administrador do sistema';
    pass2.classList.remove('hidden');
    document.getElementById('auth-password2').required = true;
    document.getElementById('auth-password').autocomplete = 'new-password';
    submit.textContent = 'Criar administrador';
    links.innerHTML = `Já tem conta? <button type="button" onclick="showAuth('login')">Entrar</button>`;
  } else if (authMode === 'signup') {
    sub.textContent = 'Crie sua conta para salvar os dados na nuvem';
    pass2.classList.remove('hidden');
    document.getElementById('auth-password2').required = true;
    document.getElementById('auth-password').autocomplete = 'new-password';
    submit.textContent = 'Criar conta';
    links.innerHTML = `Já tem conta? <button type="button" onclick="showAuth('login')">Entrar</button>`;
  } else if (authMode === 'reset') {
    sub.textContent = 'Enviaremos um link para redefinir a senha';
    passWrap.classList.add('hidden');
    document.getElementById('auth-password').required = false;
    submit.textContent = 'Enviar link';
    links.innerHTML = `<button type="button" onclick="showAuth('login')">Voltar ao login</button>`;
  } else if (authMode === 'recovery') {
    sub.textContent = 'Defina uma nova senha para sua conta';
    pass2.classList.remove('hidden');
    document.getElementById('auth-password2').required = true;
    document.getElementById('auth-email').closest('.form-group').classList.add('hidden');
    document.getElementById('auth-email').required = false;
    document.getElementById('auth-password').autocomplete = 'new-password';
    submit.textContent = 'Salvar nova senha';
    links.innerHTML = '';
  } else {
    document.getElementById('auth-email').closest('.form-group').classList.remove('hidden');
    document.getElementById('auth-password').autocomplete = 'current-password';
    sub.textContent = 'Entre com a conta fornecida pelo administrador';
    submit.textContent = 'Entrar';
    showAuthAdminNote(true);
    const signup = signupAllowed()
      ? `Não tem conta? <button type="button" onclick="showAuth('signup')">Criar conta</button> · `
      : '';
    links.innerHTML = `${signup}<button type="button" onclick="showAuth('reset')">Esqueci a senha</button>`;
  }
}

function showSetup() {
  const form = document.getElementById('auth-form');
  const setup = document.getElementById('auth-setup');
  const links = document.getElementById('auth-links');
  const sub = document.getElementById('auth-sub');
  document.getElementById('auth-screen').classList.remove('hidden');
  document.body.classList.add('auth-open');
  form.classList.add('hidden');
  links.classList.add('hidden');
  setup.classList.remove('hidden');
  showAuthAdminNote(false);
  sub.textContent = 'Conecte o projeto Supabase para ativar login e banco';
  const fallback = cfg().allowLocalFallback !== false
    ? `<button class="btn btn-secondary" onclick="startLocalMode()">Continuar só neste navegador</button>`
    : '';
  setup.innerHTML = `
    <ol>
      <li>Crie um projeto em <strong>supabase.com</strong></li>
      <li>Abra <strong>SQL Editor</strong>, cole o arquivo <code>supabase/schema.sql</code> e execute</li>
      <li>Em <strong>Project Settings → API</strong>, copie a URL e a chave <em>anon / publishable</em></li>
      <li>Cole os valores em <code>config.js</code> e recarregue esta página</li>
    </ol>
    <p>Em Authentication → URL Configuration, adicione o endereço do site (localhost e domínio de produção).</p>
    ${fallback}
  `;
}

async function submitAuth(e) {
  e.preventDefault();
  if (!sb) { setAuthError('Supabase não configurado.'); return; }
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const password2 = document.getElementById('auth-password2').value;
  const submit = document.getElementById('auth-submit');
  setAuthError('');
  submit.disabled = true;
  const prev = submit.textContent;
  submit.textContent = 'Aguarde…';
  try {
    if (authMode === 'reset') {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
      if (error) throw error;
      setAuthError('');
      document.getElementById('auth-sub').textContent = 'Se o e-mail existir, enviamos o link de redefinição.';
      return;
    }
    if (authMode === 'recovery') {
      if (password !== password2) throw new Error('As senhas não coincidem.');
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw error;
      toast('Senha atualizada!', 'success');
      return;
    }
    if (authMode === 'bootstrap') {
      if (password !== password2) throw new Error('As senhas não coincidem.');
      await callAdminFn({ email, password, role: 'admin' }, false);
      toast('Administrador criado. Entre com esses dados.', 'success');
      showAuth('login');
      document.getElementById('auth-email').value = email;
      return;
    }
    if (authMode === 'signup') {
      if (!signupAllowed()) {
        throw new Error('A conta só é criada por um administrador.');
      }
      if (password !== password2) throw new Error('As senhas não coincidem.');
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (data.user && !data.session) {
        document.getElementById('auth-sub').textContent = 'Conta criada. Confirme o e-mail para entrar.';
        showAuth('login');
        toast('Verifique sua caixa de entrada para confirmar o cadastro.', 'success');
        return;
      }
      return;
    }
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  } catch (err) {
    setAuthError(translateAuthError(err.message || 'Falha na autenticação.'));
  } finally {
    submit.disabled = false;
    submit.textContent = prev;
  }
}

function translateAuthError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid credentials')) return 'E-mail ou senha inválidos.';
  if (m.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
  if (m.includes('user already registered')) return 'Este e-mail já está cadastrado.';
  if (m.includes('signups not allowed') || m.includes('signup is disabled') || m.includes('sign up is disabled')) {
    return 'A conta só é criada por um administrador.';
  }
  if (m.includes('administrador')) return msg;
  if (m.includes('password')) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Muitas tentativas. Aguarde um momento.';
  return msg;
}

async function logout() {
  if (localOnly) {
    localOnly = false;
    currentUser = null;
    currentRole = null;
    currentUserName = '';
    appReady = false;
    S.leads = []; S.tasks = [];
    updateNavForRole();
    showSetup();
    return;
  }
  if (sb) await sb.auth.signOut();
}

async function startLocalMode() {
  localOnly = true;
  currentUser = { id: 'local', email: 'modo local' };
  currentRole = null;
  hideAuth();
  updateUserUI();
  loadLocal();
  const synced = await tryAutoSyncFromFile();
  appReady = true;
  navigate('dashboard');
  toast(synced ? 'Dados sincronizados do arquivo local.' : 'Modo local: os dados ficam só neste navegador.', synced ? 'success' : '');
}

function hideAuth() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.body.classList.remove('auth-open');
}

function updateUserUI() {
  const nameEl = document.getElementById('user-name');
  const emailEl = document.getElementById('user-email');
  const email = currentUser?.email || '';
  if (nameEl) nameEl.textContent = localOnly ? 'Modo local' : (currentUserName || email.split('@')[0] || 'Usuário');
  if (emailEl) emailEl.textContent = localOnly ? 'Somente este navegador' : email;
  updateNavForRole();
}

async function enterApp(session) {
  if (!session?.user) return;
  if (appReady && currentUser?.id === session.user.id) return;
  if (enterPromise) return enterPromise;
  enterPromise = (async () => {
    currentUser = session.user;
    localOnly = false;
    hideAuth();
    await loadCurrentProfile();
    updateUserUI();
    await loadFromCloud();
    appReady = true;
    navigate(S.view === 'users' && !isAdmin() ? 'dashboard' : (S.view || 'dashboard'));
    if (!S.leads.length) toast('CRM vazio. Adicione leads ou restaure um backup.', '');
  })().finally(() => { enterPromise = null; });
  return enterPromise;
}

function leaveApp() {
  appReady = false;
  currentUser = null;
  currentRole = null;
  currentUserName = '';
  teamUsers = [];
  S.leads = [];
  S.tasks = [];
  pendingDeletes.leads.clear();
  pendingDeletes.tasks.clear();
  updateNavForRole();
  showAuth('login');
}

async function initAuth() {
  if (!isSupabaseConfigured()) {
    showSetup();
    return;
  }
  if (typeof supabase === 'undefined' || !supabase.createClient) {
    setAuthError('Não foi possível carregar a biblioteca do Supabase.');
    showSetup();
    return;
  }
  const c = cfg();
  sb = supabase.createClient(c.url, c.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      showAuth('recovery');
      return;
    }
    if (event === 'SIGNED_OUT') {
      if (!localOnly) leaveApp();
      return;
    }
    if (event === 'INITIAL_SESSION' || (event === 'TOKEN_REFRESHED' && appReady)) return;
    if (session?.user && (event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
      await enterApp(session);
    }
  });

  const isRecovery = (window.location.hash || '').includes('type=recovery');
  const { data: { session } } = await sb.auth.getSession();
  if (isRecovery) showAuth('recovery');
  else if (session?.user) await enterApp(session);
  else {
    showAuth('login');
    try {
      const st = await callAdminFn({ action: 'status' }, false);
      if (st.needsBootstrap) showAuth('bootstrap');
    } catch (e) { /* login normal se a função não responder */ }
  }
}

// ═══════════════════════════════════════════════════
//  PERSISTENCE
// ═══════════════════════════════════════════════════
function saveLocal() {
  const payload = {leads:S.leads, tasks:S.tasks, savedAt: new Date().toISOString()};
  localStorage.setItem('scrm_v3', JSON.stringify(payload));
}

function setSaveIndicator(html, later) {
  const ind = document.getElementById('save-indicator');
  if (!ind) return;
  ind.innerHTML = html;
  if (later) setTimeout(()=>{ if (ind.innerHTML === html) ind.innerHTML = later; }, 3000);
}

function save() {
  saveLocal();
  const h = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  if (localOnly || !sb || !currentUser || currentUser.id === 'local') {
    setSaveIndicator(`✅ Salvo às ${h}`, '🔒 Auto-salvo neste navegador');
    return;
  }
  setSaveIndicator('☁️ Salvando na nuvem…');
  scheduleCloudSave();
}

function scheduleCloudSave() {
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(flushCloudSave, 700);
}

async function flushCloudSave() {
  if (!sb || !currentUser || localOnly) return;
  if (cloudSaving) { cloudQueued = true; return; }
  cloudSaving = true;
  try {
    const localLeadIds = new Set(S.leads.map(l => l.id));
    const localTaskIds = new Set(S.tasks.map(t => t.id));
    const [{ data: remoteLeads, error: e1 }, { data: remoteTasks, error: e2 }] = await Promise.all([
      sb.from('leads').select('id'),
      sb.from('tasks').select('id')
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    (remoteLeads || []).forEach(r => { if (!localLeadIds.has(r.id)) pendingDeletes.leads.add(r.id); });
    (remoteTasks || []).forEach(r => { if (!localTaskIds.has(r.id)) pendingDeletes.tasks.add(r.id); });

    const leadIds = [...pendingDeletes.leads];
    const taskIds = [...pendingDeletes.tasks];
    pendingDeletes.leads.clear();
    pendingDeletes.tasks.clear();

    if (leadIds.length) {
      const { error } = await sb.from('leads').delete().in('id', leadIds).eq('user_id', currentUser.id);
      if (error) throw error;
    }
    if (taskIds.length) {
      const { error } = await sb.from('tasks').delete().in('id', taskIds).eq('user_id', currentUser.id);
      if (error) throw error;
    }
    if (S.leads.length) {
      const { error } = await sb.from('leads').upsert(S.leads.map(toDbLead), { onConflict: 'user_id,id' });
      if (error) throw error;
    }
    if (S.tasks.length) {
      const { error } = await sb.from('tasks').upsert(S.tasks.map(toDbTask), { onConflict: 'user_id,id' });
      if (error) throw error;
    }
    const h = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    setSaveIndicator(`☁️ Salvo na nuvem às ${h}`, '☁️ Sincronizado com o Supabase');
  } catch (err) {
    setSaveIndicator('⚠️ Falha ao salvar na nuvem');
    toast(err.message || 'Não foi possível salvar no Supabase', 'error');
  } finally {
    cloudSaving = false;
    if (cloudQueued) {
      cloudQueued = false;
      scheduleCloudSave();
    }
  }
}

function loadLocal() {
  if (window.__CRM_DATA__ && Array.isArray(window.__CRM_DATA__.leads)) {
    S.leads = window.__CRM_DATA__.leads;
    S.tasks  = window.__CRM_DATA__.tasks || [];
    saveLocal();
    return;
  }
  try {
    const d = JSON.parse(localStorage.getItem('scrm_v3') || 'null');
    if (d && d.leads) {
      S.leads = d.leads;
      S.tasks = d.tasks || [];
    } else {
      S.leads = [];
      S.tasks = [];
    }
  } catch(e) {
    S.leads = [];
    S.tasks = [];
  }
}

function hasLocalData() {
  try {
    const d = JSON.parse(localStorage.getItem('scrm_v3') || 'null');
    return !!(d && ((d.leads && d.leads.length) || (d.tasks && d.tasks.length)));
  } catch(e) { return false; }
}

async function loadFromCloud() {
  if (!sb || !currentUser) return;
  const [leadsRes, tasksRes] = await Promise.all([
    sb.from('leads').select('*').order('created_at', { ascending: false }),
    sb.from('tasks').select('*').order('created_at', { ascending: false })
  ]);
  if (leadsRes.error) {
    toast('Erro ao carregar leads: ' + leadsRes.error.message, 'error');
    loadLocal();
    return;
  }
  if (tasksRes.error) {
    toast('Erro ao carregar tarefas: ' + tasksRes.error.message, 'error');
    loadLocal();
    return;
  }
  S.leads = (leadsRes.data || []).map(fromDbLead);
  S.tasks = (tasksRes.data || []).map(fromDbTask);
  saveLocal();

  if (!S.leads.length && !S.tasks.length && hasLocalData()) {
    if (confirm('Encontramos leads salvos neste navegador e a nuvem está vazia.\n\nEnviar esses dados para o Supabase?')) {
      loadLocal();
      await flushCloudSave();
      toast('Dados locais enviados para a nuvem.', 'success');
    }
  }
}

function load() {
  loadLocal();
}

function demo() {
  return [
    { id:uid(), name:'Ana Beatriz Lima', instagram:'@anabeatrizlima', phone:'(11) 98765-4321', company:'Studio AB', niche:'Moda', stage:'meeting', quality:'A', serviceType:'', firstContactDate:'2026-07-20', meetingDate:'2026-07-28', proposalDate:'', responded:true, respondedAfterProposal:false, sold:false, contractValue:2500, nextAction:'Enviar proposta detalhada', objections:'Acha caro', notes:'Muito interessada em gestão completa', history:[{date:'2026-07-20',text:'Primeiro DM enviado — respondeu rápido'},{date:'2026-07-28',text:'Reunião no Google Meet — ótima receptividade'}], createdAt:'2026-07-20' },
    { id:uid(), name:'Carlos Mendes', instagram:'@carlosmendes.fit', phone:'', company:'CM Fitness', niche:'Fitness', stage:'contacted', quality:'B', serviceType:'', firstContactDate:'2026-07-25', meetingDate:'', proposalDate:'', responded:false, respondedAfterProposal:false, sold:false, contractValue:0, nextAction:'Follow-up amanhã', objections:'', notes:'Personal trainer querendo crescer no Instagram', history:[{date:'2026-07-25',text:'DM enviado com proposta de reunião'}], createdAt:'2026-07-25' },
    { id:uid(), name:'Mariana Costa', instagram:'@docemariacafe', phone:'(21) 97654-3210', company:'Doce Maria Café', niche:'Food', stage:'closed', quality:'A', serviceType:'Gestão Social Media', firstContactDate:'2026-06-10', meetingDate:'2026-06-15', proposalDate:'2026-06-18', responded:true, respondedAfterProposal:true, sold:true, contractValue:1800, nextAction:'Planejar conteúdo de agosto', objections:'', notes:'Cliente fidelizada, ótimo relacionamento', history:[{date:'2026-06-10',text:'Contato via indicação'},{date:'2026-06-15',text:'Reunião realizada'},{date:'2026-06-20',text:'Contrato assinado 🎉'}], createdAt:'2026-06-10' },
    { id:uid(), name:'Luísa Ferreira', instagram:'@luisa.deco', phone:'(31) 99876-5432', company:'Luísa Decor', niche:'Decoração', stage:'proposal', quality:'A', serviceType:'', firstContactDate:'2026-07-28', meetingDate:'2026-08-01', proposalDate:'2026-08-02', responded:true, respondedAfterProposal:false, sold:false, contractValue:3200, nextAction:'Aguardar retorno até sexta', objections:'Quer incluir Pinterest', notes:'Loja física + e-commerce, muito potencial', history:[{date:'2026-07-28',text:'Indicação de cliente'},{date:'2026-08-02',text:'Proposta de R$3.200/mês enviada'}], createdAt:'2026-07-28' },
    { id:uid(), name:'Pedro Henrique', instagram:'@phadvogado', phone:'', company:'PH Advocacia', niche:'Jurídico', stage:'lost', quality:'C', serviceType:'', firstContactDate:'2026-07-01', meetingDate:'2026-07-08', proposalDate:'2026-07-10', responded:true, respondedAfterProposal:false, sold:false, contractValue:0, nextAction:'', objections:'Preferiu agência mais barata', notes:'Perdemos por preço', history:[{date:'2026-07-01',text:'Contato inicial'},{date:'2026-07-10',text:'Proposta enviada'},{date:'2026-07-15',text:'Recusou — foi para concorrente'}], createdAt:'2026-07-01' }
  ];
}

function demoTasks() {
  return [{ id:uid(), leadId:'', title:'Follow-up no Carlos Mendes amanhã', dueDate:'2026-08-05', priority:'high', done:false, createdAt:new Date().toISOString() }];
}

// ═══════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════
const VIEWS = ['dashboard','leads','pipeline','clients','tasks','import','reports','backup','users'];
const TITLES = { dashboard:'Dashboard', leads:'Leads', pipeline:'Pipeline Kanban', clients:'Clientes', tasks:'Tarefas', import:'Importar Leads', reports:'Relatórios', backup:'Backup & Segurança', users:'Usuários' };

function navigate(v) {
  if (v === 'users' && !isAdmin()) v = 'dashboard';
  S.view = v;
  document.querySelectorAll('.nav-item').forEach((el,i) => el.classList.toggle('active', VIEWS[i]===v));
  document.getElementById('page-title').textContent = TITLES[v] || '';
  render();
}

let _chartTimer = null;
function render() {
  clearTimeout(_chartTimer);
  Object.values(S.charts).forEach(c=>{ try{c.destroy()}catch(e){} });
  S.charts = {};
  const el = document.getElementById('content');
  if (S.view==='dashboard') el.innerHTML = vDashboard();
  else if (S.view==='leads')    el.innerHTML = vLeads();
  else if (S.view==='pipeline') { el.innerHTML = vPipeline(); initDnD(); }
  else if (S.view==='clients')  el.innerHTML = vClients();
  else if (S.view==='tasks')    el.innerHTML = vTasks();
  else if (S.view==='import')   { el.innerHTML = vImport(); initImport(); }
  else if (S.view==='reports')  { el.innerHTML = vReports(); _chartTimer = setTimeout(initCharts, 150); }
  else if (S.view==='backup')   el.innerHTML = vBackup();
  else if (S.view==='users') {
    el.innerHTML = vUsers();
    loadTeamUsers().then(() => { if (S.view==='users') document.getElementById('content').innerHTML = vUsers(); }).catch(err => toast(err.message, 'error'));
  }
}

// ═══════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════
function vDashboard() {
  const total = S.leads.length;
  const active = S.leads.filter(l=>l.stage!=='closed'&&l.stage!=='returning'&&l.stage!=='lost'&&!l.sold).length;
  const closed = S.leads.filter(l=>l.sold||l.stage==='closed'||l.stage==='returning').length;
  const revenue = S.leads.filter(l=>l.sold||l.stage==='closed'||l.stage==='returning').reduce((s,l)=>s+(+l.contractValue||0),0);
  const rate = total ? Math.round(closed/total*100) : 0;
  const pending = S.tasks.filter(t=>!t.done).length;
  const recent = [...S.leads].sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,5);

  return `
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-icon">👥</div><div class="stat-value">${total}</div><div class="stat-label">Total de Leads</div></div>
    <div class="stat-card"><div class="stat-icon">🔥</div><div class="stat-value" style="color:#009eff">${active}</div><div class="stat-label">Leads Ativos</div></div>
    <div class="stat-card"><div class="stat-icon">🏆</div><div class="stat-value" style="color:#10B981">${closed}</div><div class="stat-label">Clientes Fechados</div></div>
    <div class="stat-card"><div class="stat-icon">💰</div><div class="stat-value" style="color:#10B981;font-size:21px">R$ ${revenue.toLocaleString('pt-BR')}</div><div class="stat-label">Receita Total</div></div>
    <div class="stat-card"><div class="stat-icon">📈</div><div class="stat-value" style="color:#F59E0B">${rate}%</div><div class="stat-label">Taxa de Conversão</div><div class="progress-bar"><div class="progress-fill" style="width:${rate}%"></div></div></div>
    <div class="stat-card"><div class="stat-icon">✅</div><div class="stat-value" style="color:#3B82F6">${pending}</div><div class="stat-label">Tarefas Pendentes</div></div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:20px">
    <div class="card">
      <div style="font-weight:700;margin-bottom:14px;font-size:14px">📊 Pipeline por Estágio</div>
      ${STAGES.map(s=>{
        const n = S.leads.filter(l=>l.stage===s.id).length;
        const p = total ? Math.round(n/total*100) : 0;
        return `<div style="margin-bottom:9px">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px"><span>${s.icon} ${s.name}</span><span style="font-weight:700">${n}</span></div>
          <div class="progress-bar"><div class="progress-fill" style="width:${p}%;background:${s.color}"></div></div>
        </div>`;
      }).join('')}
    </div>
    <div class="card">
      <div style="font-weight:700;margin-bottom:14px;font-size:14px">🕐 Leads Recentes</div>
      ${recent.map(l=>{
        const sg = stage(l.stage);
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #F1F5F9;cursor:pointer" onclick="openLeadModal('${l.id}')">
          <div style="width:32px;height:32px;border-radius:50%;background:${sg.color}22;display:flex;align-items:center;justify-content:center;font-size:16px">${sg.icon}</div>
          <div style="flex:1"><div style="font-weight:600;font-size:13px">${l.name}</div><div style="font-size:11px;color:#009eff">${l.instagram||''}</div></div>
          <span class="badge ${QC[l.quality]||'badge-D'}">${l.quality||'?'}</span>
        </div>`;
      }).join('')||'<div class="text-muted" style="padding:16px 0;text-align:center">Nenhum lead ainda</div>'}
      <button class="btn btn-primary" style="width:100%;margin-top:14px" onclick="openLeadModal(null)">+ Adicionar Lead</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px">
    <div style="font-weight:700;margin-bottom:14px;font-size:14px">🛠 Serviços Fechados</div>
    ${(()=>{
      const cls = S.leads.filter(l=>l.sold||l.stage==='closed');
      if (!cls.length) return '<div class="text-muted" style="text-align:center;padding:12px 0">Nenhum cliente fechado ainda</div>';
      // agrupar por serviceType
      const map = {};
      cls.forEach(l=>{
        const k = l.serviceType?.trim() || '— Sem serviço definido';
        if (!map[k]) map[k]={count:0,revenue:0};
        map[k].count++;
        map[k].revenue += (+l.contractValue||0);
      });
      const colors = ['#009eff','#10B981','#3B82F6','#F59E0B','#EF4444','#06B6D4','#F97316','#8B5CF6'];
      return Object.entries(map).map(([k,v],i)=>`
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #F1F5F9">
        <div style="width:10px;height:10px;border-radius:50%;background:${colors[i%colors.length]};flex-shrink:0"></div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:13.5px">${k}</div>
          <div style="font-size:11.5px;color:#64748B">${v.count} cliente${v.count!==1?'s':''}</div>
        </div>
        <div style="font-weight:700;color:#10B981;font-size:13px">R$ ${v.revenue.toLocaleString('pt-BR',{minimumFractionDigits:0,maximumFractionDigits:0})}/mês</div>
      </div>`).join('');
    })()}
  </div>

  <div class="card">
    <div style="font-weight:700;margin-bottom:14px;font-size:14px">⚡ Ações Rápidas</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
      <div class="quick-action" onclick="openLeadModal(null)"><span style="font-size:22px">âž•</span><div><div style="font-weight:700;font-size:12.5px">Novo Lead</div><div style="font-size:11px;color:#94A3B8">Adicionar</div></div></div>
      <div class="quick-action" onclick="navigate('import')"><span style="font-size:22px">📥</span><div><div style="font-weight:700;font-size:12.5px">Importar CSV</div><div style="font-size:11px;color:#94A3B8">Da planilha</div></div></div>
      <div class="quick-action" onclick="navigate('pipeline')"><span style="font-size:22px">📋</span><div><div style="font-weight:700;font-size:12.5px">Pipeline</div><div style="font-size:11px;color:#94A3B8">Kanban visual</div></div></div>
      <div class="quick-action" onclick="navigate('reports')"><span style="font-size:22px">📊</span><div><div style="font-weight:700;font-size:12.5px">Relatórios</div><div style="font-size:11px;color:#94A3B8">Ver análises</div></div></div>
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════
//  LEADS TABLE
// ═══════════════════════════════════════════════════
function filtered() {
  return S.leads.filter(l=>{
    const q = S.f.q.toLowerCase();
    if (q && !l.name?.toLowerCase().includes(q) && !l.instagram?.toLowerCase().includes(q) && !l.company?.toLowerCase().includes(q)) return false;
    if (S.f.stage && l.stage!==S.f.stage) return false;
    if (S.f.quality && l.quality!==S.f.quality) return false;
    if (S.f.responded!=='' && String(l.responded)!==S.f.responded) return false;
    if (S.f.sold!=='' && String(l.sold)!==S.f.sold) return false;
    return true;
  });
}

function setF(k,v){ S.f[k]=v; render(); }
function clearF(){ S.f={q:'',stage:'',quality:'',responded:'',sold:''}; render(); }

function vLeads() {
  const rows = filtered();
  return `
  <div class="search-bar">
    <input class="search-input" type="text" placeholder="Buscar por nome, @instagram ou empresa…" value="${S.f.q}" oninput="setF('q',this.value)" style="max-width:310px">
    <select class="filter-select" onchange="setF('stage',this.value)">
      <option value="">Todos os estágios</option>
      ${STAGES.map(s=>`<option value="${s.id}" ${S.f.stage===s.id?'selected':''}>${s.icon} ${s.name}</option>`).join('')}
    </select>
    <select class="filter-select" onchange="setF('quality',this.value)">
      <option value="">Qualidade</option>
      <option value="A" ${S.f.quality==='A'?'selected':''}>🔥 Hot (A)</option>
      <option value="B" ${S.f.quality==='B'?'selected':''}>😊 Warm (B)</option>
      <option value="C" ${S.f.quality==='C'?'selected':''}>❄️ Cold (C)</option>
      <option value="D" ${S.f.quality==='D'?'selected':''}>🧊 Frozen (D)</option>
    </select>
    <select class="filter-select" onchange="setF('responded',this.value)">
      <option value="">Respondeu?</option>
      <option value="true" ${S.f.responded==='true'?'selected':''}>✅ Sim</option>
      <option value="false" ${S.f.responded==='false'?'selected':''}>❌ Não</option>
    </select>
    <select class="filter-select" onchange="setF('sold',this.value)">
      <option value="">Vendeu?</option>
      <option value="true" ${S.f.sold==='true'?'selected':''}>✅ Sim</option>
      <option value="false" ${S.f.sold==='false'?'selected':''}>❌ Não</option>
    </select>
    <button class="btn btn-secondary btn-sm" onclick="clearF()">✕ Limpar</button>
    <span class="text-muted" style="white-space:nowrap">${rows.length} lead${rows.length!==1?'s':''}</span>
  </div>

  <div class="card" style="padding:0;overflow:hidden">
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Nome / @Instagram</th><th>Telefone</th><th>Empresa</th><th>Nicho</th>
          <th>🔍 De onde veio</th><th>Serviço</th><th>Estágio</th><th>Qualidade</th><th>1º Contato</th>
          <th>Reunião</th><th>Proposta</th><th>Respondeu</th><th>Resp. Proposta</th>
          <th>Vendeu</th><th>Valor</th><th>Objeção</th>
          <th>Próxima Ação</th><th>Ações</th>
        </tr></thead>
        <tbody>
        ${rows.length ? rows.map(l=>{
          const sg = stage(l.stage);
          return `<tr>
            <td><div style="font-weight:700;font-size:13px">${l.name}</div><div style="color:#009eff;font-size:11px">${l.instagram||'—'}</div></td>
            <td style="font-size:12px;color:#374151;white-space:nowrap">${l.phone ? `<a href="https://wa.me/55${l.phone.replace(/\D/g,'')}" target="_blank" style="color:#10B981;text-decoration:none" title="Abrir WhatsApp">📱 ${l.phone}</a>` : '—'}</td>
            <td style="font-size:12.5px">${l.company||'—'}</td>
            <td><span class="tag">${l.niche||'—'}</span></td>
            <td style="font-size:12px;color:#0369A1;font-weight:600">${l.source||'—'}</td>
            <td style="font-size:12px;color:#006eb3;font-weight:600">${l.serviceType||'—'}</td>
            <td><span class="badge" style="background:${sg.color}20;color:${sg.color};font-size:10px">${sg.icon} ${sg.name}</span></td>
            <td><span class="badge ${QC[l.quality]||'badge-D'}">${QL[l.quality]||'—'}</span></td>
            <td style="font-size:12px">${fmt(l.firstContactDate)}</td>
            <td style="font-size:12px">${fmt(l.meetingDate)}</td>
            <td style="font-size:12px">${fmt(l.proposalDate)}</td>
            <td><span class="badge ${l.responded?'badge-yes':'badge-no'}">${l.responded?'✅ Sim':'❌ Não'}</span></td>
            <td><span class="badge ${l.respondedAfterProposal?'badge-yes':'badge-no'}">${l.respondedAfterProposal?'✅ Sim':'❌ Não'}</span></td>
            <td><span class="badge ${l.sold?'badge-yes':'badge-no'}">${l.sold?'✅ Sim':'❌ Não'}</span></td>
            <td style="font-size:12px;font-weight:700;color:${l.contractValue?'#10B981':'#94A3B8'}">${fmtR(l.contractValue)}</td>
            <td style="font-size:11.5px;color:#64748B;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${l.objections||''}">${l.objections||'—'}</td>
            <td style="font-size:11.5px;color:#64748B;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${l.nextAction||''}">${l.nextAction||'—'}</td>
            <td><div style="display:flex;gap:4px"><button class="action-btn action-edit" onclick="openLeadModal('${l.id}')">✏️</button><button class="action-btn action-delete" onclick="delLead('${l.id}')">🗑</button></div></td>
          </tr>`;
        }).join('') : `<tr><td colspan="14"><div class="empty-state"><div class="empty-state-icon">🔍</div><h3>Nenhum lead encontrado</h3><button class="btn btn-primary" style="margin-top:12px" onclick="openLeadModal(null)">+ Novo Lead</button></div></td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════
//  PIPELINE KANBAN
// ═══════════════════════════════════════════════════
function vPipeline() {
  return `<div style="overflow-x:auto;padding-bottom:20px">
    <div class="kanban-board" id="kb">
      ${STAGES.map(sg=>{
        const leads = S.leads.filter(l=>l.stage===sg.id);
        const val = leads.reduce((s,l)=>s+(+l.contractValue||0),0);
        return `<div class="kanban-col" data-stage="${sg.id}" ondragover="dOver(event)" ondrop="dDrop(event,'${sg.id}')">
          <div class="kanban-header" style="background:${sg.color}">
            <div class="kanban-header-left">${sg.icon} <span>${sg.name}</span></div>
            <span class="kanban-count">${leads.length}</span>
          </div>
          ${val>0?`<div style="background:${sg.color}18;padding:3px 10px;font-size:10.5px;color:${sg.color};font-weight:700">💰 R$ ${val.toLocaleString('pt-BR')}</div>`:''}
          <div class="kanban-cards" id="kc-${sg.id}">
            ${leads.map(l=>kcCard(l,sg)).join('')}
            ${!leads.length?`<div style="text-align:center;padding:16px;color:#CBD5E1;font-size:11px">Arraste leads aqui</div>`:''}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function kcCard(l, sg) {
  return `<div class="kanban-card" draggable="true" data-id="${l.id}" ondragstart="dStart(event,'${l.id}')" onclick="openLeadModal('${l.id}')" style="border-left-color:${sg.color}">
    <div class="kc-name">${l.name}</div>
    <div class="kc-ig">${l.instagram||''}</div>
    <div class="kc-meta">
      <span class="badge ${QC[l.quality]||'badge-D'}" style="font-size:9.5px">${l.quality||'?'}</span>
      ${l.contractValue?`<span style="font-size:10.5px;color:#10B981;font-weight:700">R$ ${Number(l.contractValue).toLocaleString('pt-BR')}</span>`:''}
    </div>
    ${l.nextAction?`<div class="kc-next">→ ${l.nextAction}</div>`:''}
  </div>`;
}

let dragId = null;
function dStart(e, id) { dragId=id; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; }
function dOver(e)  { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dDrop(e, stageId) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  if (!dragId) return;
  const l = S.leads.find(x=>x.id===dragId);
  if (l) {
    l.stage = stageId;
    if (stageId==='responded') l.responded = true;
    if (stageId==='closed')    l.sold = true;
    save(); render();
    toast(`Movido para "${stage(stageId).name}"`, 'success');
  }
  dragId = null;
}
function initDnD() {
  document.querySelectorAll('.kanban-col').forEach(col=>{
    col.addEventListener('dragleave', e=>{ if(!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
  });
  document.querySelectorAll('.kanban-card').forEach(c=>{
    c.addEventListener('dragend', ()=>{ c.classList.remove('dragging'); document.querySelectorAll('.kanban-col').forEach(x=>x.classList.remove('drag-over')); });
  });
}

// ═══════════════════════════════════════════════════
//  CLIENTS
// ═══════════════════════════════════════════════════
function vClients() {
  const cls = S.leads.filter(l=>l.stage==='closed'||l.stage==='returning'||l.sold);
  const rev = cls.reduce((s,l)=>s+(+l.contractValue||0),0);
  const avg = cls.length ? Math.round(rev/cls.length) : 0;
  return `
  <div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">
    <div class="stat-card"><div class="stat-icon">🏆</div><div class="stat-value" style="color:#10B981">${cls.length}</div><div class="stat-label">Clientes Ativos</div></div>
    <div class="stat-card"><div class="stat-icon">💰</div><div class="stat-value" style="color:#10B981;font-size:21px">R$ ${rev.toLocaleString('pt-BR')}</div><div class="stat-label">Receita Mensal Total</div></div>
    <div class="stat-card"><div class="stat-icon">📊</div><div class="stat-value" style="color:#009eff;font-size:21px">R$ ${avg.toLocaleString('pt-BR')}</div><div class="stat-label">Ticket Médio</div></div>
  </div>
  <div class="card" style="padding:0;overflow:hidden">
    ${cls.length ? `<div class="table-wrap"><table><thead><tr>
      <th>Cliente</th><th>Empresa</th><th>Nicho</th><th>🔍 De onde veio</th><th>🛠 Tipo de Serviço</th><th>1º Contato</th><th>Proposta</th><th>Valor/mês</th><th>Qualidade</th><th>Observações</th><th>Ações</th>
    </tr></thead><tbody>
      ${cls.map(l=>`<tr>
        <td><div style="font-weight:700">${l.name}</div><div style="color:#009eff;font-size:11px">${l.instagram||'—'}</div></td>
        <td style="font-size:12.5px">${l.company||'—'}</td>
        <td><span class="tag">${l.niche||'—'}</span></td>
        <td style="font-size:12px;font-weight:600;color:#0369A1">${l.source||'—'}</td>
        <td style="font-size:13px;font-weight:700;color:#006eb3">${l.serviceType||'—'}</td>
        <td style="font-size:12px">${fmt(l.firstContactDate)}</td>
        <td style="font-size:12px">${fmt(l.proposalDate)}</td>
        <td style="font-weight:700;color:#10B981">${fmtR(l.contractValue)}</td>
        <td><span class="badge ${QC[l.quality]||'badge-D'}">${QL[l.quality]||'—'}</span></td>
        <td style="font-size:11.5px;color:#64748B;max-width:180px">${l.notes||'—'}</td>
        <td><button class="action-btn action-edit" onclick="openLeadModal('${l.id}')">✏️</button></td>
      </tr>`).join('')}
    </tbody></table></div>` : `<div class="empty-state"><div class="empty-state-icon">🏆</div><h3>Nenhum cliente ainda</h3><p class="text-muted">Leads em "Cliente Fechado" ou "Cliente Antigo" aparecem aqui</p></div>`}
  </div>`;
}

// ═══════════════════════════════════════════════════
//  TASKS
// ═══════════════════════════════════════════════════
function vTasks() {
  const pend = S.tasks.filter(t=>!t.done);
  const done = S.tasks.filter(t=>t.done);
  const PC = { high:'#EF4444', medium:'#F59E0B', low:'#10B981' };
  const PL = { high:'Alta', medium:'Média', low:'Baixa' };
  function tRow(t) {
    const lead = S.leads.find(l=>l.id===t.leadId);
    return `<div class="task-item" style="${t.done?'opacity:.5':''}">
      <div class="task-check ${t.done?'done':''}" onclick="toggleTask('${t.id}')">${t.done?'✓':''}</div>
      <div style="flex:1">
        <div style="font-weight:600;font-size:13.5px;${t.done?'text-decoration:line-through':''}">${t.title}</div>
        ${lead?`<div style="font-size:11.5px;color:#009eff">👤 ${lead.name} (${lead.instagram||''})</div>`:''}
        ${t.dueDate?`<div style="font-size:11.5px;color:#64748B">📅 ${fmt(t.dueDate)}</div>`:''}
      </div>
      <span style="font-size:10.5px;font-weight:700;color:${PC[t.priority]};background:${PC[t.priority]}18;padding:2px 8px;border-radius:20px">${PL[t.priority]||'Normal'}</span>
      <button class="action-btn action-delete" onclick="delTask('${t.id}')" style="margin-left:6px">🗑</button>
    </div>`;
  }
  return `
  <div class="section-header">
    <div><div style="font-weight:700;font-size:15px">Tarefas de Follow-up</div><div class="text-muted">${pend.length} pendentes</div></div>
    <button class="btn btn-primary" onclick="openTaskModal()">+ Nova Tarefa</button>
  </div>
  <div class="card" style="margin-bottom:16px;padding:0">
    <div style="padding:14px 16px;font-weight:700;border-bottom:1px solid #F1F5F9">📋 Pendentes (${pend.length})</div>
    ${pend.length ? pend.map(tRow).join('') : '<div class="text-muted" style="padding:20px;text-align:center">Nenhuma tarefa pendente 🎉</div>'}
  </div>
  ${done.length?`<div class="card" style="padding:0"><div style="padding:14px 16px;font-weight:700;color:#94A3B8;border-bottom:1px solid #F1F5F9">✅ Concluídas (${done.length})</div>${done.map(tRow).join('')}</div>`:''} `;
}

function toggleTask(id) { const t=S.tasks.find(x=>x.id===id); if(t){t.done=!t.done;save();render();} }
function delTask(id)   {
  pendingDeletes.tasks.add(id);
  S.tasks=S.tasks.filter(x=>x.id!==id);
  save();render();
}

// ═══════════════════════════════════════════════════
//  IMPORT
// ═══════════════════════════════════════════════════
let pending = [];

function vImport() {
  return `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
    <div>
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px">📥 Importar via CSV</div>
        <div class="text-muted" style="margin-bottom:18px;font-size:13px">Faça upload de uma planilha CSV com seus leads</div>
        <div class="import-zone" id="import-zone" onclick="document.getElementById('csv-file').click()">
          <div style="font-size:36px;margin-bottom:10px">📄</div>
          <div style="font-weight:600;margin-bottom:3px">Clique ou arraste o arquivo aqui</div>
          <div class="text-muted" style="font-size:12.5px">Aceita .CSV e .XLSX</div>
        </div>
        <input type="file" id="csv-file" accept=".csv" style="display:none" onchange="handleFile(event)">
        <div style="margin-top:16px;padding:12px;background:#F8FAFC;border-radius:8px">
          <div style="font-weight:600;font-size:12px;margin-bottom:6px">📋 Colunas do CSV:</div>
          <code style="font-size:11px;color:#64748B;line-height:1.9">nome, instagram, empresa, nicho, estagio, qualidade,<br>primeiro_contato, reuniao, proposta, respondeu,<br>vendeu, valor, proxima_acao, objecao, observacoes</code>
        </div>
        <button class="btn btn-secondary" style="margin-top:10px;width:100%" onclick="dlTemplate()">⬇ Baixar Template CSV</button>
      </div>
    </div>
    <div>
      <div class="card">
        <div style="font-weight:700;font-size:15px;margin-bottom:10px">🔗 Conexão Automática</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="padding:12px;background:#E6F6FF;border-radius:8px;border-left:3px solid #009eff">
            <div style="font-weight:700;font-size:12.5px;color:#006eb3;margin-bottom:3px">📊 Google Forms → CSV</div>
            <div style="font-size:12px;color:#007acc">Crie um form de prospecção → resposta vai para Google Sheets → exporte como CSV → importe aqui</div>
          </div>
          <div style="padding:12px;background:#DBEAFE;border-radius:8px;border-left:3px solid #3B82F6">
            <div style="font-weight:700;font-size:12.5px;color:#1E40AF;margin-bottom:3px">âš¡ Make (Integromat) ou Zapier</div>
            <div style="font-size:12px;color:#1D4ED8">Conecte formulários, DMs ou planilhas → gere CSVs automaticamente para importar aqui</div>
          </div>
          <div style="padding:12px;background:#DCFCE7;border-radius:8px;border-left:3px solid #10B981">
            <div style="font-weight:700;font-size:12.5px;color:#166534;margin-bottom:3px">📱 Planilha de Prospecção</div>
            <div style="font-size:12px;color:#15803D">Mantenha um Google Sheets de prospecção e exporte CSV semanalmente para importar aqui</div>
          </div>
          <div style="padding:12px;background:#FEF3C7;border-radius:8px;border-left:3px solid #F59E0B">
            <div style="font-weight:700;font-size:12.5px;color:#92400E;margin-bottom:3px">🤖 Peça pra mim automatizar!</div>
            <div style="font-size:12px;color:#B45309">Me peça para criar um script que busca perfis do Instagram ou lê sua planilha e preenche o CSV automaticamente para importar aqui</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="card" id="import-preview" style="display:none;margin-top:18px">
    <div style="font-weight:700;margin-bottom:14px">👀 Preview da Importação</div>
    <div id="preview-body"></div>
    <div style="margin-top:14px;display:flex;gap:8px">
      <button class="btn btn-primary" onclick="confirmImport()">✅ Confirmar Importação</button>
      <button class="btn btn-secondary" onclick="cancelImport()">✕ Cancelar</button>
    </div>
  </div>`;
}

function initImport() {
  const z = document.getElementById('import-zone');
  if (!z) return;
  z.addEventListener('dragover', e=>{e.preventDefault();z.classList.add('drag-over');});
  z.addEventListener('dragleave', ()=>z.classList.remove('drag-over'));
  z.addEventListener('drop', e=>{e.preventDefault();z.classList.remove('drag-over');if(e.dataTransfer.files[0])processFile(e.dataTransfer.files[0]);});
}

function handleFile(e){ if(e.target.files[0]) processFile(e.target.files[0]); }

function processFile(file){
  const r = new FileReader();
  r.onload = e=>{
    const lines = e.target.result.split('\n').filter(l=>l.trim());
    if (lines.length<2){ toast('Arquivo inválido ou vazio','error'); return; }
    const hdrs = lines[0].split(',').map(h=>h.trim().toLowerCase().replace(/"/g,'').replace(/ /g,'_').replace(/-/g,'_'));
    pending = [];
    for(let i=1;i<lines.length;i++){
      const v = parseCSV(lines[i]);
      if(v.length<2) continue;
      const row = {};
      hdrs.forEach((h,j)=>{ row[h]=(v[j]||'').trim().replace(/^"|"$/g,''); });
      const yesArr = ['sim','yes','true','1'];
      pending.push({
        id:uid(),
        name:       row.nome||row.name||'',
        instagram:  row.instagram||row['@instagram']||'',
        company:    row.empresa||row.company||'',
        niche:      row.nicho||row.niche||'',
        stage:      normStage(row.estagio||row.stage||'new'),
        quality:    (row.qualidade||row.quality||'C').toUpperCase(),
        firstContactDate: row.primeiro_contato||row.first_contact||'',
        meetingDate:row.reuniao||row.meeting||'',
        proposalDate:row.proposta||row.proposal||'',
        responded:  yesArr.includes((row.respondeu||'').toLowerCase()),
        sold:       yesArr.includes((row.vendeu||'').toLowerCase()),
        contractValue:parseFloat(row.valor||row.value||0)||0,
        nextAction: row.proxima_acao||row.next_action||'',
        objections: row.objecao||row.objection||'',
        notes:      row.observacoes||row.notes||'',
        history:[], createdAt:new Date().toISOString().split('T')[0]
      });
    }
    if(!pending.length){ toast('Nenhum lead válido encontrado','error'); return; }
    showPreview();
  };
  r.readAsText(file,'UTF-8');
}

function parseCSV(line){
  const res=[]; let cur=''; let inQ=false;
  for(let ch of line){
    if(ch==='"'){inQ=!inQ;}
    else if(ch===','&&!inQ){res.push(cur);cur='';}
    else cur+=ch;
  }
  res.push(cur); return res;
}

function normStage(s){
  const m={'novo':'new','novo lead':'new','qualificado':'qualified','lead qualificado':'qualified','contato':'contacted','primeiro contato':'contacted','follow-up':'followup','followup':'followup','follow':'followup','respondeu':'responded','reunião':'meeting','reuniao':'meeting','meeting':'meeting','proposta':'proposal','proposta enviada':'proposal','negociação':'negotiation','negociacao':'negotiation','fechado':'closed','cliente fechado':'closed','closed':'closed','perdido':'lost','lost':'lost'};
  return m[s.trim().toLowerCase()]||'new';
}

function showPreview(){
  const el = document.getElementById('import-preview');
  el.style.display='block';
  document.getElementById('preview-body').innerHTML=`
  <div style="margin-bottom:8px;color:#009eff;font-weight:700;font-size:14px">${pending.length} leads prontos para importar</div>
  <div style="max-height:280px;overflow-y:auto;border:1px solid #E2E8F0;border-radius:8px">
    <table style="width:100%;font-size:12.5px"><thead><tr>
      <th style="text-align:left;padding:8px 12px;background:#F8FAFC">Nome</th>
      <th style="text-align:left;padding:8px 12px;background:#F8FAFC">Instagram</th>
      <th style="text-align:left;padding:8px 12px;background:#F8FAFC">Empresa</th>
      <th style="text-align:left;padding:8px 12px;background:#F8FAFC">Estágio</th>
      <th style="text-align:left;padding:8px 12px;background:#F8FAFC">Qualidade</th>
    </tr></thead><tbody>
    ${pending.slice(0,15).map(l=>`<tr>
      <td style="padding:7px 12px;border-top:1px solid #F1F5F9">${l.name}</td>
      <td style="padding:7px 12px;border-top:1px solid #F1F5F9;color:#009eff">${l.instagram}</td>
      <td style="padding:7px 12px;border-top:1px solid #F1F5F9">${l.company}</td>
      <td style="padding:7px 12px;border-top:1px solid #F1F5F9">${stage(l.stage).name}</td>
      <td style="padding:7px 12px;border-top:1px solid #F1F5F9">${l.quality}</td>
    </tr>`).join('')}
    ${pending.length>15?`<tr><td colspan="5" style="padding:8px;text-align:center;color:#94A3B8;font-size:12px">… e mais ${pending.length-15} leads</td></tr>`:''}
    </tbody></table>
  </div>`;
}

function confirmImport(){
  const n = pending.length;
  S.leads.push(...pending);
  pending=[];
  save();
  toast(`${n} leads importados com sucesso!`, 'success');
  navigate('leads');
}
function cancelImport(){ pending=[]; document.getElementById('import-preview').style.display='none'; }

function dlTemplate(){
  const csv = 'nome,instagram,empresa,nicho,estagio,qualidade,primeiro_contato,reuniao,proposta,respondeu,vendeu,valor,proxima_acao,objecao,observacoes\n"Maria Silva","@mariasilva","Boutique M","Moda","new","A","2026-08-01","","","não","não","0","Enviar DM","","Encontrei no Instagram"';
  dlFile(''+csv,'template_leads.csv','text/csv;charset=utf-8');
  toast('Template baixado!','success');
}

// ═══════════════════════════════════════════════════
//  REPORTS
// ═══════════════════════════════════════════════════
function vReports(){
  return `
  <div class="chart-grid">
    <div class="chart-card"><div class="chart-title">🔻 Funil de Pipeline</div><canvas id="ch-funnel" height="240"></canvas></div>
    <div class="chart-card"><div class="chart-title">⭐ Qualidade dos Leads</div><canvas id="ch-quality" height="240"></canvas></div>
  </div>
  <div class="chart-grid">
    <div class="chart-card"><div class="chart-title">📈 Leads Adicionados por Mês</div><canvas id="ch-monthly" height="240"></canvas></div>
    <div class="chart-card"><div class="chart-title">💰 Funil de Conversão</div><canvas id="ch-conv" height="240"></canvas></div>
  </div>`;
}

function initCharts(){
  if (typeof Chart === 'undefined') {
    // Chart.js não carregou (CDN offline?) — mostra sumário em texto
    const el = document.getElementById('content');
    if (!el) return;
    const closed=S.leads.filter(l=>l.sold||l.stage==='closed').length;
    const rate=S.leads.length?Math.round(closed/S.leads.length*100):0;
    el.innerHTML += `<div class="card" style="text-align:center;padding:30px;margin-top:16px">
      <p style="font-size:14px;color:#64748B;margin-bottom:12px">⚠️ Gráficos não disponíveis (verifique conexão com internet).</p>
      <p style="font-weight:700">Total: ${S.leads.length} leads · Fechados: ${closed} · Taxa de conversão: ${rate}%</p>
    </div>`;
    return;
  }
  // Destrói qualquer instância anterior nas mesmas telas (prevenção de "Canvas already in use")
  ['ch-funnel','ch-quality','ch-monthly','ch-conv'].forEach(id=>{
    const c=document.getElementById(id);
    if(c){ const ex=Chart.getChart(c); if(ex) ex.destroy(); }
  });
  const stageData = STAGES.map(s=>S.leads.filter(l=>l.stage===s.id).length);
  const qualData  = ['A','B','C','D'].map(q=>S.leads.filter(l=>l.quality===q).length);

  // Funnel
  const f = document.getElementById('ch-funnel');
  if(f) S.charts.f = new Chart(f,{type:'bar',data:{labels:STAGES.map(s=>s.name),datasets:[{data:stageData,backgroundColor:STAGES.map(s=>s.color+'CC'),borderColor:STAGES.map(s=>s.color),borderWidth:1,borderRadius:4}]},options:{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,grid:{display:false}},y:{grid:{display:false}}}}});

  // Quality
  const q = document.getElementById('ch-quality');
  if(q) S.charts.q = new Chart(q,{type:'doughnut',data:{labels:['🔥 Hot (A)','😊 Warm (B)','❄️ Cold (C)','🧊 Frozen (D)'],datasets:[{data:qualData,backgroundColor:['#10B981','#3B82F6','#F59E0B','#94A3B8'],borderWidth:0}]},options:{plugins:{legend:{position:'bottom'}},cutout:'62%'}});

  // Monthly
  const months=[], counts=[];
  for(let i=5;i>=0;i--){
    const d=new Date(); d.setMonth(d.getMonth()-i);
    const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    months.push(d.toLocaleDateString('pt-BR',{month:'short',year:'2-digit'}));
    counts.push(S.leads.filter(l=>(l.createdAt||'').startsWith(k)).length);
  }
  const m = document.getElementById('ch-monthly');
  if(m) S.charts.m = new Chart(m,{type:'line',data:{labels:months,datasets:[{label:'Leads',data:counts,borderColor:'#009eff',backgroundColor:'#009eff20',fill:true,tension:.4,pointBackgroundColor:'#009eff',pointRadius:5}]},options:{plugins:{legend:{display:false}},scales:{x:{grid:{display:false}},y:{beginAtZero:true,grid:{color:'#F1F5F9'}}}}});

  // Conversion
  const total=S.leads.length, resp=S.leads.filter(l=>l.responded).length, mtg=S.leads.filter(l=>l.meetingDate||l.stage==='meeting'||l.stage==='proposal'||l.stage==='negotiation'||l.stage==='closed').length, prop=S.leads.filter(l=>l.proposalDate||l.stage==='proposal'||l.stage==='negotiation'||l.stage==='closed').length, closed=S.leads.filter(l=>l.sold||l.stage==='closed').length;
  const cv = document.getElementById('ch-conv');
  if(cv) S.charts.c = new Chart(cv,{type:'bar',data:{labels:['Leads','Responderam','Reuniões','Propostas','Fechados'],datasets:[{data:[total,resp,mtg,prop,closed],backgroundColor:['#6B728060','#F59E0B60','#F9731660','#06B6D460','#10B98160'],borderColor:['#6B7280','#F59E0B','#F97316','#06B6D4','#10B981'],borderWidth:2,borderRadius:6}]},options:{plugins:{legend:{display:false}},scales:{x:{grid:{display:false}},y:{beginAtZero:true,grid:{color:'#F1F5F9'}}}}});
}

// ═══════════════════════════════════════════════════
//  LEAD MODAL
// ═══════════════════════════════════════════════════
function openLeadModal(id){
  S.editId = id;
  const l = id ? S.leads.find(x=>x.id===id) : null;
  document.getElementById('modal-title').textContent = l ? `Editar — ${l.name}` : 'Novo Lead';

  const stageOpts = STAGES.map(s=>`<option value="${s.id}" ${(l?.stage||'new')===s.id?'selected':''}>${s.icon} ${s.name}</option>`).join('');

  document.getElementById('modal-body').innerHTML = `
  <div class="form-section">
    <div class="form-section-title">Informações Básicas</div>
    <div class="form-grid">
      <div class="form-group"><label>Nome Completo *</label><input id="l-name" type="text" value="${l?.name||''}" placeholder="Ex: Maria Silva"></div>
      <div class="form-group"><label>@Instagram</label><input id="l-ig" type="text" value="${l?.instagram||''}" placeholder="@usuario"></div>
      <div class="form-group"><label>📱 Telefone / WhatsApp</label><input id="l-phone" type="text" value="${l?.phone||''}" placeholder="(11) 99999-9999"></div>
      <div class="form-group"><label>Empresa / Marca</label><input id="l-co" type="text" value="${l?.company||''}" placeholder="Nome da empresa"></div>
      <div class="form-group"><label>Nicho</label><input id="l-ni" type="text" value="${l?.niche||''}" placeholder="Ex: Moda, Fitness, Food…"></div>
      <div class="form-group"><label>🔍 De onde veio?</label><input id="l-src" type="text" value="${l?.source||''}" placeholder="Ex: Instagram, Indicação, Stories, Ads…"></div>
    </div>
  </div>
  <div class="form-section">
    <div class="form-section-title">Pipeline & Qualidade</div>
    <div class="form-grid">
      <div class="form-group"><label>Estágio do Pipeline</label><select id="l-stage">${stageOpts}</select></div>
      <div class="form-group"><label>🛠 Tipo de Serviço</label><input id="l-svc" type="text" value="${l?.serviceType||''}" placeholder="Ex: Gestão Social Media, Consultoria…"></div>
      <div class="form-group"><label>Qualidade do Lead</label>
        <select id="l-q">
          <option value="A" ${l?.quality==='A'?'selected':''}>🔥 Hot (A) — Muito interessado</option>
          <option value="B" ${(l?.quality==='B'||!l?.quality)?'selected':''}>😊 Warm (B) — Interessado</option>
          <option value="C" ${l?.quality==='C'?'selected':''}>❄️ Cold (C) — Pouco interesse</option>
          <option value="D" ${l?.quality==='D'?'selected':''}>🧊 Frozen (D) — Sem interesse</option>
        </select>
      </div>
    </div>
  </div>
  <div class="form-section">
    <div class="form-section-title">Datas</div>
    <div class="form-grid form-grid-3">
      <div class="form-group"><label>📅 1º Contato</label><input id="l-d1" type="date" value="${l?.firstContactDate||''}"></div>
      <div class="form-group"><label>📅 Reunião</label><input id="l-dm" type="date" value="${l?.meetingDate||''}"></div>
      <div class="form-group"><label>📅 Proposta Enviada</label><input id="l-dp" type="date" value="${l?.proposalDate||''}"></div>
    </div>
  </div>
  <div class="form-section">
    <div class="form-section-title">Status & Resultados</div>
    <div class="form-grid">
      <div class="form-group"><label>Respondeu?</label>
        <div style="display:flex;gap:14px;margin-top:4px">
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="resp" value="1" ${l?.responded?'checked':''} style="accent-color:#009eff"> Sim</label>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="resp" value="0" ${!l?.responded?'checked':''} style="accent-color:#009eff"> Não</label>
        </div>
      </div>
      <div class="form-group"><label>Vendeu?</label>
        <div style="display:flex;gap:14px;margin-top:4px">
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="sold" value="1" ${l?.sold?'checked':''} style="accent-color:#009eff"> Sim</label>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="sold" value="0" ${!l?.sold?'checked':''} style="accent-color:#009eff"> Não</label>
        </div>
      </div>
      <div class="form-group"><label>Respondeu após a proposta?</label>
        <div style="display:flex;gap:14px;margin-top:4px">
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="rap" value="1" ${l?.respondedAfterProposal?'checked':''} style="accent-color:#06B6D4"> Sim</label>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="radio" name="rap" value="0" ${!l?.respondedAfterProposal?'checked':''} style="accent-color:#06B6D4"> Não</label>
        </div>
      </div>
      <div class="form-group"><label>💰 Valor do Contrato (R$)</label><input id="l-val" type="text" value="${l?.contractValue ? fmtValInput(l.contractValue) : ''}" placeholder="Ex: 1800 ou 1.800"></div>
      <div class="form-group"><label>⚡ Próxima Ação</label><input id="l-next" type="text" value="${l?.nextAction||''}" placeholder="Ex: Ligar amanhã às 14h"></div>
    </div>
  </div>
  <div class="form-section">
    <div class="form-section-title">Objeções & Observações</div>
    <div class="form-grid">
      <div class="form-group"><label>❌ Objeção</label><input id="l-obj" type="text" value="${l?.objections||''}" placeholder="Ex: Acha caro, não tem tempo…"></div>
      <div class="form-group form-full"><label>📝 Observações</label><textarea id="l-notes" placeholder="Anotações livres sobre o lead…">${l?.notes||''}</textarea></div>
    </div>
  </div>
  ${l ? `
  <div class="form-section">
    <div class="form-section-title">📋 Histórico de Contatos</div>
    <div id="hist-list">
      ${(l.history||[]).map(h=>`<div class="history-item"><div class="history-dot"></div><div class="history-content"><div>${h.text}</div><div class="history-date">${fmt(h.date)}</div></div></div>`).join('')}
      ${!(l.history||[]).length?'<div class="text-muted">Nenhum registro ainda</div>':''}
    </div>
    <div class="history-add">
      <input id="hist-input" type="text" placeholder="Registrar novo contato, resposta, interação…">
      <button class="btn btn-secondary btn-sm" onclick="addHist('${l.id}')">+ Adicionar</button>
    </div>
  </div>` : ''}`;

  document.getElementById('modal-footer').innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
    ${l?`<button class="btn btn-danger btn-sm" onclick="delLead('${l.id}');closeModal()">🗑 Excluir Lead</button>`:''}
    <button class="btn btn-primary" onclick="saveLead()">💾 Salvar</button>`;

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('the-modal').scrollTop = 0;
}

function addHist(lid){
  const inp = document.getElementById('hist-input');
  const text = inp.value.trim();
  if (!text) return;
  const l = S.leads.find(x=>x.id===lid);
  if (!l) return;
  if (!l.history) l.history=[];
  const entry = {date:new Date().toISOString().split('T')[0], text};
  l.history.push(entry);
  save();
  inp.value='';
  const list = document.getElementById('hist-list');
  list.insertAdjacentHTML('beforeend',`<div class="history-item"><div class="history-dot"></div><div class="history-content"><div>${text}</div><div class="history-date">Hoje</div></div></div>`);
  list.querySelector('.text-muted')?.remove();
  toast('Histórico registrado!','success');
}

function saveLead(){
  const name = document.getElementById('l-name')?.value.trim();
  if (!name){ toast('Informe o nome do lead','error'); return; }
  const data = {
    name,
    instagram:      document.getElementById('l-ig')?.value.trim()||'',
    phone:          document.getElementById('l-phone')?.value.trim()||'',
    company:        document.getElementById('l-co')?.value.trim()||'',
    niche:          document.getElementById('l-ni')?.value.trim()||'',
    source:         document.getElementById('l-src')?.value.trim()||'',
    stage:          document.getElementById('l-stage')?.value||'new',
    serviceType:    document.getElementById('l-svc')?.value.trim()||'',
    quality:        document.getElementById('l-q')?.value||'B',
    firstContactDate:document.getElementById('l-d1')?.value||'',
    meetingDate:    document.getElementById('l-dm')?.value||'',
    proposalDate:   document.getElementById('l-dp')?.value||'',
    responded:      document.querySelector('input[name="resp"]:checked')?.value==='1',
    sold:           document.querySelector('input[name="sold"]:checked')?.value==='1',
    respondedAfterProposal: document.querySelector('input[name="rap"]:checked')?.value==='1',
    contractValue:  parseMoney(document.getElementById('l-val')?.value),
    nextAction:     document.getElementById('l-next')?.value.trim()||'',
    objections:     document.getElementById('l-obj')?.value.trim()||'',
    notes:          document.getElementById('l-notes')?.value.trim()||''
  };
  if (S.editId){
    const i = S.leads.findIndex(x=>x.id===S.editId);
    if (i>=0) S.leads[i] = {...S.leads[i], ...data};
    toast('Lead atualizado!','success');
  } else {
    S.leads.unshift({id:uid(),...data,history:[],createdAt:new Date().toISOString().split('T')[0]});
    toast('Lead adicionado!','success');
  }
  save(); closeModal(); render();
}

function delLead(id){
  if(!confirm('Excluir este lead?')) return;
  pendingDeletes.leads.add(id);
  S.tasks.filter(x=>x.leadId===id).forEach(t=>pendingDeletes.tasks.add(t.id));
  S.leads = S.leads.filter(x=>x.id!==id);
  S.tasks = S.tasks.filter(x=>x.leadId!==id);
  save(); render(); toast('Lead excluído','success');
}

function closeModal(){ document.getElementById('modal-overlay').classList.add('hidden'); S.editId=null; }
function overlayClick(e){ if(e.target===document.getElementById('modal-overlay')) closeModal(); }

// ═══════════════════════════════════════════════════
//  TASK MODAL
// ═══════════════════════════════════════════════════
function openTaskModal(){
  document.getElementById('modal-title').textContent='Nova Tarefa';
  const opts = S.leads.map(l=>`<option value="${l.id}">${l.name} (${l.instagram||''})</option>`).join('');
  document.getElementById('modal-body').innerHTML=`
  <div class="form-grid">
    <div class="form-group form-full"><label>Título *</label><input id="t-title" type="text" placeholder="Ex: Follow-up no Direct"></div>
    <div class="form-group"><label>Lead Vinculado</label><select id="t-lead"><option value="">Sem lead</option>${opts}</select></div>
    <div class="form-group"><label>Data de Vencimento</label><input id="t-due" type="date"></div>
    <div class="form-group"><label>Prioridade</label><select id="t-pri"><option value="high">🔴 Alta</option><option value="medium" selected>🟡 Média</option><option value="low">🟢 Baixa</option></select></div>
  </div>`;
  document.getElementById('modal-footer').innerHTML=`<button class="btn btn-secondary" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveTask()">💾 Salvar Tarefa</button>`;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function saveTask(){
  const t = document.getElementById('t-title')?.value.trim();
  if(!t){ toast('Informe o título','error'); return; }
  S.tasks.push({id:uid(),leadId:document.getElementById('t-lead').value,title:t,dueDate:document.getElementById('t-due').value,priority:document.getElementById('t-pri').value,done:false,createdAt:new Date().toISOString()});
  save(); closeModal(); navigate('tasks'); toast('Tarefa criada!','success');
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function vUsers() {
  if (!isAdmin()) {
    return `<div class="empty-state"><div class="empty-state-icon">🛡️</div><h3>Acesso restrito</h3><p>Somente administradores podem gerenciar contas.</p></div>`;
  }
  const rows = teamUsers.length ? teamUsers.map(u => {
    const when = u.created_at ? new Date(u.created_at).toLocaleString('pt-BR') : '—';
    const roleLabel = u.role === 'admin' ? 'Administrador' : 'Usuário';
    const mine = u.id === currentUser?.id;
    return `<tr>
      <td><strong>${escHtml(u.name || u.email.split('@')[0])}</strong>${mine ? ' <span class="text-muted">(você)</span>' : ''}</td>
      <td>${escHtml(u.email)}</td>
      <td><span class="role-badge ${u.role === 'admin' ? 'admin' : 'user'}">${roleLabel}</span></td>
      <td class="text-muted">${when}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="4" class="text-muted" style="text-align:center;padding:22px">Nenhuma conta listada ainda</td></tr>`;

  return `
  <div class="users-layout">
    <div class="card">
      <div style="font-weight:700;font-size:15px;margin-bottom:6px">Criar conta</div>
      <p class="text-muted" style="margin-bottom:16px">Só o administrador cria usuários. A pessoa já consegue entrar com e-mail e senha.</p>
      <form onsubmit="submitCreateUser(event)">
        <div class="form-group"><label>Nome</label><input id="u-name" type="text" placeholder="Nome da pessoa"></div>
        <div class="form-group"><label>E-mail *</label><input id="u-email" type="email" required placeholder="pessoa@empresa.com"></div>
        <div class="form-group"><label>Senha provisória *</label><input id="u-pass" type="password" required minlength="6" autocomplete="new-password" placeholder="Mínimo 6 caracteres"></div>
        <div class="form-group"><label>Confirmar senha *</label><input id="u-pass2" type="password" required minlength="6" autocomplete="new-password" placeholder="Repita a senha"></div>
        <div class="form-group"><label>Permissão</label>
          <select id="u-role">
            <option value="user">Usuário</option>
            <option value="admin">Administrador</option>
          </select>
        </div>
        <div class="auth-error hidden" id="u-error"></div>
        <button type="submit" class="btn btn-primary" id="u-submit" style="width:100%;justify-content:center">Criar conta</button>
      </form>
    </div>
    <div class="card">
      <div class="section-header" style="margin-bottom:10px">
        <div style="font-weight:700;font-size:15px">Contas do sistema</div>
        <span class="text-muted">${teamUsers.length} ${teamUsers.length === 1 ? 'conta' : 'contas'}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Permissão</th><th>Criada em</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

async function submitCreateUser(e) {
  e.preventDefault();
  if (!isAdmin()) { toast('Apenas administradores podem criar contas.', 'error'); return; }
  const name = document.getElementById('u-name').value.trim();
  const email = document.getElementById('u-email').value.trim();
  const password = document.getElementById('u-pass').value;
  const password2 = document.getElementById('u-pass2').value;
  const role = document.getElementById('u-role').value;
  const errEl = document.getElementById('u-error');
  const submit = document.getElementById('u-submit');
  const showErr = (msg) => { if (!errEl) return; if (!msg) { errEl.classList.add('hidden'); errEl.textContent = ''; return; } errEl.textContent = msg; errEl.classList.remove('hidden'); };
  showErr('');
  if (password !== password2) { showErr('As senhas não coincidem.'); return; }
  submit.disabled = true;
  const prev = submit.textContent;
  submit.textContent = 'Criando…';
  try {
    await callAdminFn({ email, password, name, role }, true);
    toast('Conta criada. A pessoa já pode entrar.', 'success');
    await loadTeamUsers();
    if (S.view === 'users') document.getElementById('content').innerHTML = vUsers();
  } catch (err) {
    showErr(err.message || 'Não foi possível criar a conta.');
  } finally {
    submit.disabled = false;
    submit.textContent = prev;
  }
}

// ═══════════════════════════════════════════════════
//  BACKUP VIEW
// ═══════════════════════════════════════════════════

function vBackup() {
  const saved = JSON.parse(localStorage.getItem('scrm_v3') || '{}');
  const lastSave = saved.savedAt ? new Date(saved.savedAt) : null;
  const lastSaveStr = lastSave
    ? lastSave.toLocaleDateString('pt-BR') + ' às ' + lastSave.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})
    : 'Nunca';
  const history = JSON.parse(localStorage.getItem('scrm_backup_history') || '[]');
  const cloudOn = !!(sb && currentUser && !localOnly);

  return `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px">
    <div class="card">
      <div style="font-weight:700;font-size:15px;margin-bottom:16px">${cloudOn ? '☁️ Status da nuvem' : '🔒 Status do Auto-save'}</div>
      <div style="display:flex;align-items:center;gap:12px;padding:14px;background:${cloudOn ? '#E6F6FF' : '#DCFCE7'};border-radius:10px;margin-bottom:14px">
        <span style="font-size:26px">${cloudOn ? '☁️' : '✅'}</span>
        <div>
          <div style="font-weight:700;color:${cloudOn ? '#006eb3' : '#166534'}">${cloudOn ? 'Sincronizado com o Supabase' : 'Auto-save neste navegador'}</div>
          <div style="font-size:12px;color:${cloudOn ? '#007acc' : '#15803D'}">${cloudOn ? 'Leads e tarefas são salvos na conta ' + (currentUser.email || '') : 'Cada alteração é salva automaticamente neste navegador'}</div>
        </div>
      </div>
      <div style="font-size:13px;color:#374151;margin-bottom:6px">📅 Último save: <strong>${lastSaveStr}</strong></div>
      <div style="font-size:13px;color:#374151;margin-bottom:6px">👥 Leads salvos: <strong>${S.leads.length}</strong></div>
      <div style="font-size:13px;color:#374151">✅ Tarefas salvas: <strong>${S.tasks.length}</strong></div>
    </div>
    <div class="card">
      <div style="font-weight:700;font-size:15px;margin-bottom:16px">⬇ Backup Manual</div>
      <p style="font-size:13px;color:#64748B;margin-bottom:14px">Salva todos os dados em um arquivo no seu computador.</p>
      <button class="btn btn-primary" style="width:100%;margin-bottom:8px" onclick="backupAgora()">💾 Baixar backup agora</button>
      <button class="btn btn-secondary" style="width:100%;margin-bottom:8px" onclick="enviarParaClaude()">⬆ Sincronizar com Claude / Firefox</button>
      <button class="btn btn-secondary btn-sm" style="width:100%" onclick="document.getElementById('restore-bk').click()">📂 Restaurar de um backup</button>
      <input type="file" id="restore-bk" accept=".json" style="display:none" onchange="restoreJSON(event)">
    </div>
  </div>

  <div class="card" style="margin-bottom:20px">
    <div style="font-weight:700;font-size:15px;margin-bottom:14px">🦊 Sincronização com Firefox</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div style="padding:14px;background:#FFF7ED;border-radius:10px;border-left:3px solid #F97316">
        <div style="font-weight:700;font-size:13px;color:#9A3412;margin-bottom:5px">Cowork → Firefox</div>
        <div style="font-size:12px;color:#C2410C;margin-bottom:10px">Gera um HTML com seus dados embutidos para abrir direto no Firefox.</div>
        <button class="btn btn-sm" style="background:#F97316;color:#fff;width:100%" onclick="gerarParaFirefox()">🦊 Gerar HTML para Firefox</button>
      </div>
      <div style="padding:14px;background:#E6F6FF;border-radius:10px;border-left:3px solid #009eff">
        <div style="font-weight:700;font-size:13px;color:#006eb3;margin-bottom:5px">Sincronizar com Claude</div>
        <div style="font-size:12px;color:#007acc;margin-bottom:10px">Baixa o JSON e manda para o Claude no chat — ele atualiza tudo.</div>
        <button class="btn btn-sm" style="background:#009eff;color:#fff;width:100%" onclick="enviarParaClaude()">⬆ Sincronizar</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div style="font-weight:700;font-size:15px;margin-bottom:4px">📋 Histórico de Backups Manuais</div>
    <div style="font-size:12px;color:#64748B;margin-bottom:14px">Registros de quando você baixou um backup nesta sessão</div>
    ${history.length ? history.slice().reverse().map(h=>`
      <div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #F1F5F9">
        <span style="font-size:18px">💾</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">${h.leads} leads · ${h.tasks} tarefas</div>
          <div style="font-size:11.5px;color:#94A3B8">${h.date}</div>
        </div>
        <span style="font-size:11px;background:#DCFCE7;color:#166534;padding:2px 8px;border-radius:20px;font-weight:700">✓ Salvo</span>
      </div>`).join('')
    : '<div class="text-muted" style="text-align:center;padding:16px 0">Nenhum backup manual ainda nesta sessão</div>'}
  </div>`;
}

function backupAgora() {
  backupJSON();
  const history = JSON.parse(localStorage.getItem('scrm_backup_history') || '[]');
  history.push({
    date: new Date().toLocaleDateString('pt-BR') + ' às ' + new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
    leads: S.leads.length,
    tasks: S.tasks.length
  });
  if (history.length > 20) history.splice(0, history.length - 20);
  localStorage.setItem('scrm_backup_history', JSON.stringify(history));
  if (S.view === 'backup') render();
}

// ═══════════════════════════════════════════════════
//  GERAR HTML PARA FIREFOX — dados embutidos dentro do arquivo
// ═══════════════════════════════════════════════════

// Exporta dados para o Claude sincronizar com Firefox
function enviarParaClaude() {
  const data = {leads:S.leads, tasks:S.tasks, savedAt:new Date().toISOString(), version:'scrm_v3'};
  dlFile(JSON.stringify(data,null,2), 'crm_data.json', 'application/json');
  toast('📎 Arquivo baixado! Arraste o crm_data.json para o chat do Claude e diga "sincronizar". O Firefox vai atualizar automaticamente.', 'success');
}

function gerarParaFirefox() {
  const data = JSON.stringify({
    leads: S.leads,
    tasks: S.tasks,
    savedAt: new Date().toISOString()
  });

  // Pega o HTML atual da página
  let html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;

  // Remove qualquer bloco __CRM_DATA__ anterior (evita acúmulo em re-exportações)
  html = html.replace(/<script[^>]*id="crm-embed"[^>]*>[\s\S]*?<\/script>/i, '');

  // Injeta os dados logo após o <head>
  const injectTag = `<script id="crm-embed">window.__CRM_DATA__ = ${data};<\/script>`;
  html = html.replace('<head>', '<head>\n' + injectTag);

  const nome = 'crm_firefox_' + new Date().toLocaleDateString('pt-BR').replace(/\//g,'-') + '.html';
  dlFile(html, nome, 'text/html;charset=utf-8');

  toast('🦊 Arquivo gerado! Baixe e abra no Firefox — seus dados já estão dentro.', 'success');
}

// Tenta carregar crm_data.json da mesma pasta (funciona no Firefox com file://)
async function tryAutoSyncFromFile() {
  try {
    const resp = await fetch('./crm_data.json?t=' + Date.now());
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data.leads || !Array.isArray(data.leads)) return false;

    const lsRaw = localStorage.getItem('scrm_v3');
    const lsDate = lsRaw ? new Date(JSON.parse(lsRaw).savedAt||0).getTime() : 0;
    const fileDate = new Date(data.savedAt||0).getTime();

    if (fileDate > lsDate) {
      S.leads = data.leads;
      S.tasks  = data.tasks || [];
      save();
      return true;
    }
    return false;
  } catch(e) {
    return false; // arquivo não existe ou fetch bloqueado (normal no Chrome)
  }
}

// ═══════════════════════════════════════════════════
//  BACKUP / RESTORE (para usar no Firefox ou outro navegador)
// ═══════════════════════════════════════════════════

function backupJSON() {
  const data = {leads:S.leads, tasks:S.tasks, backupDate: new Date().toISOString(), version:'scrm_v3'};
  const filename = `crm_backup_${new Date().toLocaleDateString('pt-BR').replace(/\//g,'-')}.json`;
  dlFile(JSON.stringify(data, null, 2), filename, 'application/json');
  toast('Backup salvo! Abra o Firefox, carregue o CRM e clique em 📂 Restaurar para importar.', 'success');
}

function restoreJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.leads) { toast('Arquivo de backup inválido','error'); return; }
      if (!confirm(`Restaurar ${data.leads.length} leads do backup de ${data.backupDate ? new Date(data.backupDate).toLocaleDateString('pt-BR') : 'data desconhecida'}?\n\nIsso substituirá os dados atuais.`)) return;
      S.leads = data.leads || [];
      S.tasks = data.tasks || [];
      save();
      render();
      toast(`✅ ${S.leads.length} leads restaurados com sucesso!`, 'success');
    } catch(err) { toast('Erro ao ler o arquivo de backup','error'); }
  };
  r.readAsText(file,'UTF-8');
  e.target.value = ''; // reset input
}

// ═══════════════════════════════════════════════════
//  EXPORT
// ═══════════════════════════════════════════════════
function exportCSV(){
  const hdr = ['nome','instagram','empresa','nicho','estagio','qualidade','primeiro_contato','reuniao','proposta','respondeu','vendeu','valor','proxima_acao','objecao','observacoes'];
  const rows = S.leads.map(l=>[l.name,l.instagram,l.company,l.niche,stage(l.stage).name,l.quality,l.firstContactDate,l.meetingDate,l.proposalDate,l.responded?'Sim':'Não',l.sold?'Sim':'Não',l.contractValue,l.nextAction,l.objections,l.notes].map(v=>`"${(v||'').toString().replace(/"/g,'""')}"`).join(','));
  dlFile(''+[hdr.join(','),...rows].join('\n'), `crm_${new Date().toLocaleDateString('pt-BR').replace(/\//g,'-')}.csv`,'text/csv;charset=utf-8');
  toast('Leads exportados!','success');
}

function dlFile(content, name, type){
  const b=new Blob([content],{type}), u=URL.createObjectURL(b), a=document.createElement('a');
  a.href=u; a.download=name; a.click(); URL.revokeObjectURL(u);
}

// ═══════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async ()=>{
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeModal(); });
  window.addEventListener('beforeunload', () => { saveLocal(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  await initAuth();
});

