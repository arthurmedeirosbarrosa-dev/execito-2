// Servidor do painel — login oficial do Roblox (OAuth), igual ao Rover.
// Requer Node 18+ e: npm i express pg
//   DATABASE_URL (opcional) -> Postgres (ex.: Supabase/Neon/Render). Com ele, histórico, fichas, CDP e auditoria
//   sobrevivem a reinícios. Sem ele, tudo funciona, mas fica só na memória.
//
// Variáveis de ambiente necessárias (configure no Render, aba "Environment"):
//   ROBLOX_CLIENT_ID, ROBLOX_CLIENT_SECRET  -> criados em https://create.roblox.com/dashboard/credentials (aba OAuth 2.0)
//   ROBLOX_REDIRECT_URI -> ex.: https://seu-servidor.onrender.com/auth/callback (cadastre esse mesmo endereço no painel do Roblox)
//   FRONTEND_URL        -> endereço do site publicado (para liberar CORS e redirecionar de volta)
//   ROBLOX_API_KEY      -> Open Cloud, com permissão de editar membros do grupo (create.roblox.com/dashboard/credentials)
//   GROUP_ID            -> ID do grupo (opcional, já vem com o valor do "EB Exército Brasileiro do Yso")
//   TURNSTILE_SECRET_KEY -> não usado neste servidor; pode deixar em branco
//
// No painel OAuth do Roblox, marque os escopos "openid" e "profile".

const express = require("express"), crypto = require("crypto");
const { ROBLOX_API_KEY: KEY, ROBLOX_CLIENT_ID: CID, ROBLOX_CLIENT_SECRET: CSECRET, ROBLOX_REDIRECT_URI: REDIRECT_URI, FRONTEND_URL: SITE_ORIGIN } = process.env;
const GROUP = process.env.GROUP_ID || "196751381"; // "EB" Exército Brasileiro do Yso

// Escada oficial de patentes do grupo "YSO", do mais baixo ao mais alto, com o ID real
// de cada cargo no Roblox. A promoção/rebaixamento segue esta lista, não a ordem genérica
// que a API do Roblox devolve (que pode vir fora de ordem).
const LADDER = [
  { id: 12884901889, name: "Recruta" },
  { id: 715019054, name: "Soldado" },
  { id: 713989066, name: "Cabo" },
  { id: 715025062, name: "Terceiro Sargento" },
  { id: 711739168, name: "Segundo Sargento" },
  { id: 710511162, name: "Primeiro Sargento" },
  { id: 714853049, name: "Subtenente" },
  { id: 715001058, name: "Cadete" },
  { id: 712889286, name: "Aspirante à Oficial" },
  { id: 714371076, name: "Segundo Tenente" },
  { id: 715297056, name: "Primeiro Tenente" },
  { id: 713887094, name: "Capitão" },
  { id: 713249156, name: "Major" },
  { id: 714691047, name: "Tenente Coronel" },
  { id: 715001059, name: "Coronel" },
  { id: 714805131, name: "General de Brigada" },
  { id: 713919074, name: "General de Divisão" },
  { id: 715019055, name: "General de Exército" },
  { id: null, name: "Sub-Patriarca" },   // ID preenchido sozinho (pelo nome do cargo no grupo)
  { id: null, name: "Patriarca" },
  { id: null, name: "Soberano" },
  { id: 715223052, name: "Subcomandante" },
  { id: 713051207, name: "Comandante" },
];
// CDP (tempo de espera) para ser promovido AO cargo indicado, em horas.
// Recruta não tem CDP. Os Oficiais Soberanos (Sub-Patriarca, Patriarca, Soberano) não entram
// aqui: só poder total muda para eles, e poder total ignora o CDP.
const CDP_HORAS = {
  "Soldado": 1, "Cabo": 3,
  "Terceiro Sargento": 6, "Segundo Sargento": 12, "Primeiro Sargento": 16,
  "Subtenente": 22, "Cadete": 30,
  "Aspirante à Oficial": 40, "Segundo Tenente": 52, "Primeiro Tenente": 66,
  "Capitão": 84, "Major": 108, "Tenente Coronel": 138, "Coronel": 174,
  "General de Brigada": 276, "General de Divisão": 348, "General de Exército": 432,
};
// Exigências manuais (o servidor não consegue verificar; o aviso aparece para quem promove).
const CDP_NOTAS = {
  "Subtenente": "Exige aprovação no exame de admissão da AMAN.",
  "Cadete": "Exige patrulhamentos e participação em eventuais da AMAN.",
};
const fmtEspera = ms => {
  const min = Math.ceil(ms / 60000), h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h}h ${m}min` : `${h}h`) : `${m}min`;
};

// Teto da promoção automática (quem não tem poder total só sobe até aqui).
const AUTO_TOP_NAME = "General de Exército";

// Nicks do Roblox (minúsculo) de quem é CEx ou SGEx: podem promover OU rebaixar
// qualquer militar para qualquer patente, menos a si mesmos. Edite esta lista à mão
// sempre que alguém virar ou deixar de ser CEx/SGEx.
const SUPER_USERS = ["tutu2345no", "guigui26799", "joelindo6", "ysodmdg"];
// Além da lista acima, Creator e Sub Creator têm esse mesmo poder total automaticamente,
// por serem cargo real do grupo no Roblox (nomes exatos, sem tag) — não precisa cadastrar nick.
const SUPER_TAGS = ["Creator", "Sub Creator"];
function isSuper(nick, roleName) {
  if (SUPER_USERS.includes(String(nick || "").toLowerCase())) return true;
  return !!roleName && SUPER_TAGS.some(tag => roleName.includes(tag));
}

const app = express();
app.use(express.json());
app.use((q, s, n) => {
  // "*" é seguro aqui: não usamos cookies/sessão de navegador, só tokens passados explicitamente.
  s.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
  q.method === "OPTIONS" ? s.end() : n();
});

const sessions = new Map();   // token  -> { id, nick }
const lastPromo = new Map();  // id do militar (Roblox) -> timestamp da última mudança de patente
// Endereço do site. Se FRONTEND_URL estiver apontando para o claude.ai (versão antiga), ignora e usa o GitHub Pages.
const SITE = (SITE_ORIGIN && !/claude\./i.test(SITE_ORIGIN)) ? SITE_ORIGIN : "https://arthurmedeirosbarrosa-dev.github.io/execito-2/";
// "state" do login assinado (HMAC): continua válido mesmo se o Render reiniciar no meio do login.
const firmar = v => crypto.createHmac("sha256", String(CSECRET || "yso-state")).update(v).digest("hex").slice(0, 24);
const novoState = () => { const v = Date.now().toString(36) + "." + crypto.randomBytes(6).toString("hex"); return v + "." + firmar(v); };
const stateOk = st => { const p = String(st || "").split("."); return p.length === 3 && firmar(p[0] + "." + p[1]) === p[2] && Date.now() - parseInt(p[0], 36) < 30 * 60000; };
const pending  = new Map();   // state  -> return URL (anti-CSRF do login)
const oneTime  = new Map();   // authcode -> token (troca única depois do redirect)

// ---- Armazenamento (Postgres se houver DATABASE_URL; senão só memória) ----
const db = { lastPromo: {}, hist: [], fichas: {}, audit: [], treinos: [], atividades: [], orgs: [], config: {} };
let pool = null, saving;
(async () => {
  try {
    if (process.env.DATABASE_URL) {
      const { Pool } = require("pg");
      pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await pool.query("create table if not exists kv(k text primary key, v jsonb)");
      const r = await pool.query("select v from kv where k='db'");
      if (r.rows[0]) Object.assign(db, r.rows[0].v);
    }
  } catch (e) { console.log("Banco desligado:", e.message); }
  for (const k in db.lastPromo) lastPromo.set(k, db.lastPromo[k]);
})();
function persist() {
  db.lastPromo = Object.fromEntries(lastPromo);
  clearTimeout(saving);
  saving = setTimeout(() => pool && pool.query("insert into kv values('db',$1) on conflict (k) do update set v=$1", [JSON.stringify(db)]).catch(() => {}), 500);
}
// Auditoria: quem fez, o quê, quando e de qual IP.
function audit(q, quem, acao, detalhe) {
  const ip = q ? String(q.headers["x-forwarded-for"] || q.socket.remoteAddress || "").split(",")[0].trim() : "sistema";
  if (db.config.webhook) fetch(db.config.webhook, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: `**${acao}** — ${detalhe} (por ${quem})`.slice(0, 1900) }) }).catch(() => {});
  db.audit.push({ quem, acao, detalhe, ip, data: new Date().toISOString() });
  if (db.audit.length > 2000) db.audit.shift();
  persist();
}

const j = (u, o) => fetch(u, o).then(r => r.json());

// 1) Manda a pessoa para a tela OFICIAL do Roblox. A senha é digitada lá, nunca no nosso site.
app.get("/auth/start", (q, s) => {
  const state = novoState();
  const url = new URL("https://apis.roblox.com/oauth/v1/authorize");
  url.search = new URLSearchParams({
    client_id: CID, redirect_uri: REDIRECT_URI, scope: "openid profile",
    response_type: "code", state
  }).toString();
  s.redirect(url.toString());
});

// 2) O Roblox manda a pessoa de volta pra cá com um "code" de uso único. Em vez de tentar
// redirecionar automaticamente de volta ao site (o que falha dentro da janela do Claude),
// mostramos um código curto na tela para a pessoa colar manualmente no site.
// Página de aviso escura (no lugar do texto branco puro) quando o login falha.
const aviso = msg => `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yso System</title>
<style>html,body{margin:0;min-height:100%;background:#04080a;color:#dff7ea;font-family:system-ui,sans-serif}body{display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px}
.c{max-width:380px;border:1px solid #15382c;border-radius:14px;padding:26px;background:#0a1411;box-shadow:0 0 30px rgba(57,255,136,.12)}h2{color:#39ff88;letter-spacing:.1em;text-transform:uppercase;margin:0 0 10px}
a{display:inline-block;margin-top:16px;padding:11px 18px;border:1px solid #39ff88;border-radius:8px;color:#39ff88;text-decoration:none;font-weight:700}</style></head>
<body><div class="c"><h2>Yso System</h2><p>${msg}</p><a href="${SITE}">Voltar ao site</a></div></body></html>`;
app.get("/auth/callback", async (q, s) => {
  try {
    const { code, state } = q.query;
    if (!stateOk(state)) return s.status(400).send(aviso("Login expirado. Volte ao site e tente de novo."));

    const tok = await j("https://apis.roblox.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CID, client_secret: CSECRET,
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI
      })
    });
    if (!tok.access_token) return s.status(400).send(aviso("O Roblox recusou o login."));

    const me = await j("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { Authorization: "Bearer " + tok.access_token }
    });

    const session = crypto.randomUUID();
    sessions.set(session, { id: me.sub, nick: me.preferred_username });

    const authcode = Math.random().toString(36).slice(2, 6).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    oneTime.set(authcode, session);
    setTimeout(() => oneTime.delete(authcode), 10 * 60000); // expira em 10 min se não for usado

    // Volta direto para o site, já logado (sem pedir código).
    const volta = new URL(SITE);
    volta.searchParams.set("authcode", authcode);
    s.redirect(volta.toString());
  } catch (e) { s.status(500).send(aviso("Falha ao falar com o Roblox. Tente de novo em instantes.")); }
});

// Foto de perfil (headshot) do Roblox para um ID de usuário.
async function avatar(id) {
  try {
    const d = await j(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`);
    return (d.data && d.data[0] && d.data[0].imageUrl) || null;
  } catch (e) { return null; }
}

// Quanto falta de CDP para a PRÓXIMA promoção de quem está logado.
// O servidor só sabe a data da última mudança feita por este painel (fica na memória).
function cdpInfo(id, roleId, superUser) {
  const idx = LADDER.findIndex(x => x.id === roleId);
  const next = idx === -1 ? null : LADDER[idx + 1];
  if (!next) return { proxima: null, restanteMs: 0, semRegistro: false };
  const total = (CDP_HORAS[next.name] || 0) * 3600000;
  const last = lastPromo.get(String(id));
  if (superUser || !total) return { proxima: next.name, totalMs: total, restanteMs: 0, semRegistro: false };
  if (!last) return { proxima: next.name, totalMs: total, restanteMs: 0, semRegistro: true };
  return { proxima: next.name, totalMs: total, restanteMs: Math.max(0, total - (Date.now() - last)), semRegistro: false };
}

// 3) O site troca o código de uma única vez por nick + patente atual no grupo.
app.get("/api/session", async (q, s) => {
  const session = oneTime.get(q.query.code);
  oneTime.delete(q.query.code);
  const me = session && sessions.get(session);
  if (!me) return s.json({ error: "Login expirado, entre de novo." });
  const r = await role(me.id);
  if (!r) return s.json({ error: "Você não está no grupo do jogo." });
  const sup = isSuper(me.nick, r.name);
  s.json({ token: session, nick: me.nick, label: r.name, isSuper: sup, cfg: CONFIG_USERS.includes(me.nick.toLowerCase()),
           perm: permDe(me.nick, r.name, r.id), avatar: await avatar(me.id), cdp: cdpInfo(me.id, r.id, sup) });
});

// Atualiza o cabeçalho (patente + CDP) sem precisar logar de novo. O site chama a cada ~30s.
app.get("/api/me", async (q, s) => {
  try {
    const me = sessions.get(q.query.token);
    if (!me) return s.json({ error: "Sessão inválida. Entre de novo." });
    const r = await role(me.id);
    if (!r) return s.json({ error: "Você não está no grupo do jogo." });
    const sup = isSuper(me.nick, r.name);
    s.json({ nick: me.nick, label: r.name, isSuper: sup, cfg: CONFIG_USERS.includes(me.nick.toLowerCase()), perm: permDe(me.nick, r.name, r.id), avatar: await avatar(me.id), cdp: cdpInfo(me.id, r.id, sup) });
  } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); }
});

// Lista pública das patentes do grupo, para preencher a lista de escolha do CEx/SGEx no site.
app.get("/api/roles", (q, s) => s.json(LADDER.filter(x => x.id)));
app.get("/api/cdp", (q, s) => s.json(CDP_HORAS));

app.get("/auth/logout", (q, s) => s.redirect(/^https:\/\/[^\/]*github\.io\//.test(q.query.return || "") ? q.query.return : SITE));

async function user(nick) {
  const d = await j("https://users.roblox.com/v1/usernames/users", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [nick], excludeBannedUsers: true })
  });
  return d.data && d.data[0];
}
async function role(id) { // cargo atual no grupo: {id, name, rank}
  const d = await j(`https://groups.roblox.com/v2/users/${id}/groups/roles`);
  const g = d.data.find(x => String(x.group.id) === String(GROUP));
  return g && g.role;
}

// ================= Sistema de permissões =================
const norm = x => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
async function resolverLadder() { // acha o ID dos cargos sem ID (Soberanos) pelo nome, direto no grupo
  try {
    const d = await j(`https://groups.roblox.com/v1/groups/${GROUP}/roles`);
    LADDER.forEach(e => { if (!e.id) { const r = (d.roles || []).find(x => norm(x.name) === norm(e.name)); if (r) e.id = r.id; } });
  } catch (e) {}
}
resolverLadder();

// Teto: até qual patente cada faixa promove (a patente-alvo, não a de quem promove).
const TETO = [
  { de: "Aspirante à Oficial", ate: "Coronel", teto: "Cadete" },                // Oficiais Subalternos a Superiores
  { de: "General de Brigada", ate: "General de Exército", teto: "Coronel" },     // Oficiais Generais
  { de: "Sub-Patriarca", ate: "Soberano", teto: "General de Exército" },         // Oficiais Soberanos
  { de: "Subcomandante", ate: "Comandante", teto: "Patriarca" },                 // CMD e SCMD
];
// Cargos fora da escada que também chegam até Patriarca (procura a palavra no nome do cargo).
const TETO_PALAVRAS = ["presidente", "investidor", "socio"];
// Só a administração (Fiscal para cima) e a CEx entregam estes cargos.
const ADM_ONLY = ["Subcomandante", "Comandante"];
// SGEx por palavra no nome do cargo, do maior para o menor (vale o primeiro que bater).
const SGEX = [
  { palavras: ["diretor"], acoes: ["advertir", "anular", "rebaixar", "exilar", "blacklist"], atipica: true },  // Vice Diretor+
  { palavras: ["chefe de area"], acoes: ["advertir", "anular", "rebaixar", "exilar"], atipica: true },
  { palavras: ["coordenador"], acoes: ["advertir", "anular", "rebaixar"], atipica: false },
  { palavras: ["supervisor"], acoes: ["advertir", "anular", "rebaixar"], atipica: false },
  { palavras: ["aprendiz", "secretario"], acoes: ["advertir", "rebaixar"], atipica: false },                  // Aprendiz a Secretário Sênior
  { palavras: ["estagiario"], acoes: [], atipica: false },                                                      // sem permissão
];
function idxDe(roleName, roleId) {
  let i = roleId ? LADDER.findIndex(x => x.id && String(x.id) === String(roleId)) : -1;
  if (i === -1) { // por nome: o maior nome da escada contido no nome do cargo
    const nn = norm(roleName); let best = -1, len = 0;
    LADDER.forEach((x, k) => { const m = norm(x.name); if (nn.includes(m) && m.length > len) { best = k; len = m.length; } });
    i = best;
  }
  return i;
}
function tetoDe(roleName, roleId) {
  const n = idxDe(roleName, roleId);
  for (const f of TETO) {
    const a = LADDER.findIndex(x => x.name === f.de), b = LADDER.findIndex(x => x.name === f.ate);
    if (n !== -1 && n >= a && n <= b) return f.teto;
  }
  const nn = norm(roleName);
  return TETO_PALAVRAS.some(p => nn.includes(p)) ? "Patriarca" : null;
}
// Toda a CEx (lista SUPER_USERS + Creator/Sub Creator) tem promoção atípica e todas as ações.
function permDe(nick, roleName, roleId) {
  const sup = isSuper(nick, roleName), n = norm(roleName), g = SGEX.find(x => x.palavras.some(p => n.includes(p)));
  return {
    atipica: sup || /fiscal|diretor/.test(n) || !!(g && g.atipica),
    rebaixar: sup || !!(g && g.acoes.includes("rebaixar")),
    admin: sup || /fiscal|diretor/.test(n),
    teto: sup ? "Comandante" : tetoDe(roleName, roleId),
    acoes: sup ? ["advertir", "anular", "rebaixar", "exilar", "blacklist"] : (g ? g.acoes : []),
  };
}

//A patente de quem promove vem da sessão (logada no Roblox), nunca do navegador.
// body.toRoleId presente -> só usado se "me" tiver poder total (CEx, SGEx, CR ou SCR);
// nesse caso pode escolher qualquer patente, inclusive para rebaixar. Sem isso, continua
// a regra antiga: só sobe uma patente, e só se a patente de quem promove for maior.
app.post("/api/promote", async (q, s) => {
  try {
    const me = sessions.get(q.body.token);
    if (!me) return s.json({ error: "Sessão inválida. Entre de novo." });
    const t = await user(q.body.target);
    if (!t) return s.json({ error: "Militar não encontrado." });
    if (t.id === me.id) return s.json({ error: "Você não pode promover a si mesmo." });

    const [mine, cur] = await Promise.all([role(me.id), role(t.id)]);
    if (!mine || !cur) return s.json({ error: "Os dois precisam estar no grupo." });

    const meSuper = isSuper(me.nick, mine.name);
    if (!meSuper && isSuper(t.name, cur.name)) return s.json({ error: "Você não pode alterar um membro da CEx." });
    const perm = permDe(me.nick, mine.name, mine.id);
    const curIdx = LADDER.findIndex(x => x.id === cur.id);
    if (LADDER.some(x => !x.id)) await resolverLadder();

    let next, atipicaUsada = false;
    if (q.body.toRoleId) { // promoção atípica: qualquer patente
      if (!perm.atipica) return s.json({ error: "Você não tem acesso à promoção atípica." });
      next = LADDER.find(x => String(x.id) === String(q.body.toRoleId));
      if (!next) return s.json({ error: "Patente escolhida não existe." });
      if (next.id === cur.id) return s.json({ error: "Esse militar já está nessa patente." });
      if (ADM_ONLY.includes(next.name) && !perm.admin) return s.json({ error: next.name + " só a administração do exército (Fiscal para cima) entrega." });
      atipicaUsada = true;
    } else if (q.body.rebaixar) {
      if (!perm.rebaixar) return s.json({ error: "Seu cargo não pode rebaixar." });
      if (curIdx < 1) return s.json({ error: "Esse militar não pode ser rebaixado (já está na base ou fora da escada)." });
      next = LADDER[curIdx - 1];
    } else {
      if (curIdx === -1) return s.json({ error: "Esse militar está num cargo fora da escada de patentes." });
      next = LADDER[curIdx + 1];
      if (!next) return s.json({ error: "Patente máxima da escada." });
      if (!perm.teto) return s.json({ error: "Seu cargo não tem permissão para promover." });
      const tetoIdx = LADDER.findIndex(x => x.name === perm.teto);
      if (tetoIdx === -1 || curIdx + 1 > tetoIdx) return s.json({ error: `Seu cargo só promove até ${perm.teto}.` });
    }
    if (!next.id) return s.json({ error: `O cargo ${next.name} não foi encontrado no grupo do Roblox.` });

    // Poder total (CEx, SGEx, Creator, Sub Creator) não espera CDP.
    // Os demais esperam o CDP do cargo para o qual o militar está subindo.
    const cdpMs = (CDP_HORAS[next.name] || 0) * 3600000;
    if (!meSuper && !atipicaUsada && cdpMs) {
      const last = lastPromo.get(String(t.id));
      if (last && Date.now() - last < cdpMs) {
        return s.json({ error: `CDP de ${next.name}: falta ${fmtEspera(cdpMs - (Date.now() - last))}` });
      }
    }

    const r = await fetch(`https://apis.roblox.com/cloud/v2/groups/${GROUP}/memberships/${t.id}`, {
      method: "PATCH", headers: { "x-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ role: `groups/${GROUP}/roles/${next.id}` })
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return s.json({ error: `O Roblox recusou (status ${r.status}): ${detail.slice(0, 300)}` });
    }

    const baixou = LADDER.findIndex(x => x.id === next.id) < curIdx;
    if (!atipicaUsada && !baixou) lastPromo.set(String(t.id), Date.now()); // CDP automático (só Promoção Normal)
    db.hist.push({ id: t.id, nick: t.name, from: cur.name, to: next.name, by: me.nick, date: new Date().toISOString() });
    const tipoAcao = baixou ? "Rebaixamento" : (atipicaUsada ? "Promoção Atípica" : "Promoção Normal");
    if (baixou) { const f = db.fichas[t.id] || (db.fichas[t.id] = { estado: "Ativo", registros: [] });
      (f.punicoes = f.punicoes || []).push({ tipo: "Rebaixamento", motivo: String(q.body.motivo || "").trim().slice(0, 200), de: cur.name, para: next.name, por: me.nick, data: new Date().toISOString() }); }
    audit(q, me.nick, tipoAcao, `${t.name}: ${cur.name} → ${next.name}` + (q.body.motivo ? ` (${String(q.body.motivo).slice(0, 200)})` : ""));
    s.json({ nick: t.name, from: cur.name, to: next.name, note: CDP_NOTAS[next.name] || null });
  } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); }
});

// ================= Efetivo, ficha e auditoria =================
// Permissões: ver o efetivo e as fichas = qualquer militar logado. Editar ficha = Capitão ou maior (ou poder total).
// Ver a auditoria = só poder total.
const EDIT_MIN = "Capitão";
async function who(q) {
  const me = sessions.get(q.query.token || (q.body && q.body.token));
  if (!me) return null;
  const r = await role(me.id);
  if (!r) return null;
  return { ...me, role: r, sup: isSuper(me.nick, r.name), idx: LADDER.findIndex(x => x.id === r.id) };
}
const canEdit = w => w.sup || w.idx >= LADDER.findIndex(x => x.name === EDIT_MIN);
const NOSESS = { error: "Sessão inválida. Entre de novo." };

let cache = { t: 0, list: [] };
async function carregarGrupo(force) {
  if (!force && Date.now() - cache.t < 300000) return cache.list; // atualiza a cada 5 min
  const out = []; let c = "";
  for (let i = 0; i < 15; i++) {
    const d = await j(`https://groups.roblox.com/v1/groups/${GROUP}/users?limit=100&sortOrder=Asc${c ? "&cursor=" + c : ""}`);
    (d.data || []).forEach(x => out.push({ id: x.user.userId, nick: x.user.username, patente: x.role.name, idx: LADDER.findIndex(l => l.id === x.role.id) }));
    if (!d.nextPageCursor) break; c = d.nextPageCursor;
  }
  cache = { t: Date.now(), list: out }; return out;
}
const nomeOrg = id => (db.orgs.find(o => o.id === id) || {}).nome || "";
app.get("/api/efetivo", async (q, s) => {
  try {
    if (!(await who(q))) return s.json(NOSESS);
    const l = await carregarGrupo();
    s.json(l.map(m => ({ ...m, estado: (db.fichas[m.id] || {}).estado || "Ativo", div: nomeOrg((db.fichas[m.id] || {}).div) })));
  } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); }
});

app.get("/api/ficha", async (q, s) => {
  try {
    const w = await who(q); if (!w) return s.json(NOSESS);
    const t = await user(q.query.nick); if (!t) return s.json({ error: "Militar não encontrado." });
    const r = await role(t.id), f = db.fichas[t.id] || { estado: "Ativo", registros: [] };
    s.json({ nick: t.name, patente: r && r.name, avatar: await avatar(t.id), estado: f.estado, registros: f.registros,
             promocoes: db.hist.filter(h => h.id === t.id).reverse(), podeEditar: canEdit(w), div: f.div || "", orgs: db.orgs,
      treinos: db.treinos.map(tr => ({ ...(tr.presencas.find(p => p.nick.toLowerCase() === t.name.toLowerCase()) || {}), titulo: tr.titulo, data: tr.data })).filter(x => x.status),
      atividades: (() => { const l = db.atividades.filter(a => a.participantes.some(p => p.toLowerCase() === t.name.toLowerCase())); return { n: l.length, min: l.reduce((z, a) => z + a.minutos, 0) }; })() });
  } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); }
});

app.post("/api/ficha", async (q, s) => {
  try {
    const w = await who(q); if (!w) return s.json(NOSESS);
    if (!canEdit(w)) return s.json({ error: "Sem permissão: só " + EDIT_MIN + " ou maior edita fichas." });
    const t = await user(q.body.target); if (!t) return s.json({ error: "Militar não encontrado." });
    const f = db.fichas[t.id] || (db.fichas[t.id] = { estado: "Ativo", registros: [] });
    if (q.body.div !== undefined) {
      f.div = db.orgs.some(o => o.id === q.body.div) ? q.body.div : ""; audit(q, w.nick, "Organização", `${t.name} → ${nomeOrg(f.div) || "sem unidade"}`);
    } else if (q.body.estado) {
      if (!["Ativo", "Inativo", "Licença"].includes(q.body.estado)) return s.json({ error: "Estado inválido." });
      f.estado = q.body.estado; audit(q, w.nick, "Estado", `${t.name} → ${f.estado}`);
    } else {
      const texto = String(q.body.texto || "").trim().slice(0, 300);
      if (!["Punição", "Medalha", "Observação"].includes(q.body.tipo) || !texto) return s.json({ error: "Preencha o tipo e o texto." });
      f.registros.push({ tipo: q.body.tipo, texto, por: w.nick, data: new Date().toISOString() });
      audit(q, w.nick, q.body.tipo, `${t.name}: ${texto}`);
    }
    persist(); s.json({ ok: true });
  } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); }
});


// ================= Treinos, atividades, organização, config e sincronização =================
const wrap = fn => async (q, s) => { try { const w = await who(q); if (!w) return s.json(NOSESS); await fn(q, s, w); } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); } };
const NOPERM = { error: "Sem permissão para isso." };
const txt = (v, n) => String(v || "").trim().slice(0, n);
const id6 = () => crypto.randomBytes(4).toString("hex");

app.get("/api/treinos", wrap((q, s) => s.json(db.treinos.slice(-50).reverse())));
app.post("/api/treino", wrap((q, s, w) => {
  if (!canEdit(w)) return s.json(NOPERM);
  const titulo = txt(q.body.titulo, 80); if (!titulo) return s.json({ error: "Dê um título ao treino." });
  db.treinos.push({ id: id6(), titulo, data: txt(q.body.data, 40), instrutor: txt(q.body.instrutor, 200), aux: txt(q.body.aux, 200), presencas: [], por: w.nick });
  audit(q, w.nick, "Treino criado", titulo); s.json({ ok: true });
}));
app.post("/api/treino/marcar", wrap((q, s, w) => {
  if (!canEdit(w)) return s.json(NOPERM);
  const tr = db.treinos.find(x => x.id === q.body.id), nick = txt(q.body.nick, 30);
  if (!tr || !nick || !["Presente", "Aprovado", "Reprovado", "Faltou"].includes(q.body.status)) return s.json({ error: "Escolha o treino, o nick e o status." });
  tr.presencas = tr.presencas.filter(p => p.nick.toLowerCase() !== nick.toLowerCase());
  tr.presencas.push({ nick, status: q.body.status, nota: txt(q.body.nota, 40) });
  audit(q, w.nick, "Presença", `${nick}: ${q.body.status} em ${tr.titulo}`); s.json({ ok: true });
}));

app.get("/api/atividades", wrap((q, s) => s.json(db.atividades.slice(-50).reverse())));
app.post("/api/atividade", wrap((q, s, w) => {
  if (!canEdit(w)) return s.json(NOPERM);
  const titulo = txt(q.body.titulo, 80), minutos = Math.round(Number(q.body.minutos));
  const participantes = txt(q.body.participantes, 1000).split(",").map(x => x.trim()).filter(Boolean).slice(0, 50);
  if (!titulo || !["Patrulha", "Missão", "Operação"].includes(q.body.tipo) || !(minutos > 0 && minutos <= 1440) || !participantes.length)
    return s.json({ error: "Preencha tipo, título, duração (1 a 1440 min) e participantes separados por vírgula." });
  db.atividades.push({ id: id6(), tipo: q.body.tipo, titulo, minutos, participantes, por: w.nick, data: new Date().toISOString() });
  audit(q, w.nick, q.body.tipo, `${titulo} (${minutos} min, ${participantes.length} participantes)`); s.json({ ok: true });
}));

app.get("/api/orgs", wrap((q, s) => s.json(db.orgs)));
app.post("/api/org", wrap((q, s, w) => {
  if (!w.sup) return s.json(NOPERM);
  if (q.body.apagar) { db.orgs = db.orgs.filter(o => o.id !== q.body.apagar); for (const k in db.fichas) if (db.fichas[k].div === q.body.apagar) db.fichas[k].div = ""; audit(q, w.nick, "Unidade apagada", q.body.apagar); return s.json({ ok: true }); }
  const nome = txt(q.body.nome, 60);
  if (!nome || !["Divisão", "Companhia", "Pelotão"].includes(q.body.tipo)) return s.json({ error: "Preencha o nome e o tipo." });
  db.orgs.push({ id: id6(), nome, tipo: q.body.tipo, cmt: txt(q.body.cmt, 30), subcmt: txt(q.body.subcmt, 30) });
  audit(q, w.nick, "Unidade criada", `${q.body.tipo} ${nome}`); s.json({ ok: true });
}));

// A chave da API e o ID do grupo ficam nas variáveis do Render (mais seguro); aqui só se vê o status.

// Sincronização: quem saiu do grupo vira Inativo e perde o CDP guardado. Roda sozinha a cada hora.
async function syncGrupo(q, quem) {
  const ids = new Set((await carregarGrupo(true)).map(m => String(m.id)));
  let fora = 0;
  for (const id in db.fichas) { const f = db.fichas[id];
    if (!ids.has(id) && f.estado !== "Inativo") { f.estado = "Inativo"; f.registros.push({ tipo: "Observação", texto: "Saiu do grupo (sincronização).", por: "Sistema", data: new Date().toISOString() }); fora++; } }
  for (const k of Object.keys(db.lastPromo)) if (!ids.has(k)) { delete db.lastPromo[k]; lastPromo.delete(k); }
  persist(); if (fora) audit(q, quem, "Sincronização", `${fora} militar(es) fora do grupo marcados como Inativo`);
  return { total: ids.size, fora };
}
setInterval(() => syncGrupo(null, "Sistema").catch(() => {}), 3600000);
app.post("/api/sync", wrap(async (q, s, w) => w.sup ? s.json(await syncGrupo(q, w.nick)) : s.json(NOPERM)));

// ================= Yso System: Bio-Code, perfil, punições, auditoria e configurações =================
const CONFIG_USERS = ["tutu2345no", "joelindo6", "ysodmdg"]; // só estes acessam Configurações

// --- Entrar pelo Bio-Code: o site gera o código, a pessoa põe na bio do Roblox e o site confere.
const bio = new Map(), bioPorId = new Map(); // código único, válido por 10 min
app.post("/auth/bio/start", async (q, s) => {
  try {
    const t = await user(txt(q.body.nick, 30)); if (!t) return s.json({ error: "Nick não encontrado no Roblox." });
    if (!(await role(t.id))) return s.json({ error: "Esse nick não está no grupo do jogo." });
    const velho = bioPorId.get(t.id); if (velho) bio.delete(velho);
    let c; do { c = "YSO-" + crypto.randomBytes(3).toString("hex").toUpperCase(); } while (bio.has(c));
    bio.set(c, { id: t.id, exp: Date.now() + 600000 }); bioPorId.set(t.id, c);
    setTimeout(() => { if (bio.has(c)) { bio.delete(c); bioPorId.delete(t.id); } }, 600000);
    s.json({ codigo: c, nick: t.name, segundos: 600 });
  } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); }
});
app.post("/auth/bio/check", async (q, s) => {
  try {
    const t = await user(txt(q.body.nick, 30)); if (!t) return s.json({ error: "Nick não encontrado no Roblox." });
    const c = bioPorId.get(t.id), e = c && bio.get(c);
    if (!e || e.exp < Date.now()) return s.json({ error: "Código expirado ou não gerado. Gere um novo." });
    const d = await j(`https://users.roblox.com/v1/users/${t.id}`);
    if (!String(d.description || "").includes(c)) return s.json({ error: "Não achei o código na sua bio. Salve a bio no Roblox e tente de novo." });
    bio.delete(c); bioPorId.delete(t.id); // uso único
    const r = await role(t.id); if (!r) return s.json({ error: "Você não está no grupo do jogo." });
    const token = crypto.randomUUID(); sessions.set(token, { id: String(t.id), nick: t.name });
    s.json({ token, nick: t.name, label: r.name, isSuper: isSuper(t.name, r.name), cfg: CONFIG_USERS.includes(t.name.toLowerCase()), perm: permDe(t.name, r.name, r.id) });
  } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); }
});

// --- Visual do site (público): nome, cor e capa. Quem edita é CONFIG_USERS.
app.get("/api/site", (q, s) => s.json({ nome: db.config.nome || "Yso System", cor: db.config.cor || "#39ff88", capa: db.config.capa || "capa.jpg" }));
app.get("/api/config", wrap((q, s, w) => CONFIG_USERS.includes(w.nick.toLowerCase())
  ? s.json({ nome: db.config.nome || "Yso System", cor: db.config.cor || "#39ff88", capa: db.config.capa || "capa.jpg", webhook: !!db.config.webhook, group: GROUP, apiKey: !!KEY }) : s.json(NOPERM)));
app.post("/api/config", wrap((q, s, w) => {
  if (!CONFIG_USERS.includes(w.nick.toLowerCase())) return s.json(NOPERM);
  const b = q.body, c = db.config;
  if (b.nome !== undefined) c.nome = txt(b.nome, 30) || "Yso System";
  if (b.cor !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(b.cor)) return s.json({ error: "Cor inválida (use #39ff88)." }); c.cor = b.cor; }
  if (b.capa !== undefined) { const u = txt(b.capa, 300); if (u && !/^(https:\/\/|[\w.\/-]+$)/.test(u)) return s.json({ error: "Capa inválida." }); c.capa = u; }
  if (b.webhook) { if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(b.webhook)) return s.json({ error: "Isso não parece um webhook do Discord." }); c.webhook = b.webhook; }
  audit(q, w.nick, "Configuração", "Configurações do site alteradas"); s.json({ ok: true });
}));

// --- Fotos em lote para o Efetivo (até 100 por vez)
app.get("/api/avatares", wrap(async (q, s) => {
  const ids = String(q.query.ids || "").split(",").filter(x => /^\d+$/.test(x)).slice(0, 100);
  if (!ids.length) return s.json({});
  const d = await j(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.join(",")}&size=150x150&format=Png&isCircular=false`);
  const o = {}; (d.data || []).forEach(x => { o[x.targetId] = x.imageUrl; }); s.json(o);
}));

// --- Perfil (sem nick = o próprio)
app.get("/api/perfil", wrap(async (q, s, w) => {
  const t = q.query.nick ? await user(txt(q.query.nick, 30)) : { id: w.id, name: w.nick };
  if (!t) return s.json({ error: "Militar não encontrado." });
  const r = await role(t.id), f = db.fichas[t.id] || {}, P = f.punicoes || [], proprio = String(t.id) === String(w.id);
  const inst = [];
  if (r && isSuper(t.name, r.name)) inst.push({ nome: "CEx", cargo: r.name });
  if (r && SGEX.some(g => g.palavras.some(p => norm(r.name).includes(p)))) inst.push({ nome: "SGEx", cargo: r.name });
  const pun = tp => P.filter(x => x.tipo === tp).reverse();
  s.json({ id: t.id, nick: t.name, patente: r && r.name, avatar: await avatar(t.id), discord: f.discord || "", descricao: f.descricao || "",
    instituicoes: inst.concat(f.instituicoes || []), instManual: (f.instituicoes || []).map(x => `${x.nome} — ${x.cargo}`).join("\n"),
    disciplina: { advertencias: pun("Advertência"), rebaixamentos: pun("Rebaixamento"), exilios: pun("Exílio") },
    proprio, editaInst: w.sup, cdp: proprio && r ? cdpInfo(t.id, r.id, w.sup) : null });
}));
app.post("/api/perfil", wrap((q, s, w) => {
  const f = db.fichas[w.id] || (db.fichas[w.id] = { estado: "Ativo", registros: [] });
  if (q.body.descricao !== undefined) f.descricao = txt(q.body.descricao, 500);
  if (q.body.discord !== undefined) f.discord = txt(q.body.discord, 40);
  persist(); s.json({ ok: true });
}));
app.post("/api/perfil/inst", wrap(async (q, s, w) => { // instituições além de CEx/SGEx (divisão, STM, OAEx, DPU, RCE, MPM...)
  if (!w.sup) return s.json(NOPERM);
  const t = await user(txt(q.body.target, 30)); if (!t) return s.json({ error: "Militar não encontrado." });
  const f = db.fichas[t.id] || (db.fichas[t.id] = { estado: "Ativo", registros: [] });
  f.instituicoes = String(q.body.texto || "").split("\n").map(l => l.split("—").map(x => x.trim())).filter(p => p[0]).slice(0, 15).map(p => ({ nome: p[0].slice(0, 40), cargo: (p[1] || "").slice(0, 40) }));
  audit(q, w.nick, "Instituições", `${t.name}: atualizadas`); s.json({ ok: true });
}));

// --- Advertência e Exílio (Rebaixamento e promoções saem por /api/promote)
app.post("/api/punir", wrap(async (q, s, w) => {
  const tipo = q.body.tipo, nec = { "Advertência": "advertir", "Exílio": "exilar" }[tipo];
  if (!nec || !permDe(w.nick, w.role.name, w.role.id).acoes.includes(nec)) return s.json(NOPERM);
  const motivo = txt(q.body.motivo, 200); if (!motivo) return s.json({ error: "Escreva o motivo." });
  const t = await user(txt(q.body.target, 30)); if (!t) return s.json({ error: "Militar não encontrado." });
  if (String(t.id) === String(w.id)) return s.json({ error: "Você não pode aplicar isso em si mesmo." });
  const r = await role(t.id); if (r && isSuper(t.name, r.name) && !w.sup) return s.json({ error: "Você não pode punir um membro da CEx." });
  const f = db.fichas[t.id] || (db.fichas[t.id] = { estado: "Ativo", registros: [] });
  (f.punicoes = f.punicoes || []).push({ tipo, motivo, por: w.nick, data: new Date().toISOString() });
  if (tipo === "Exílio") f.estado = "Inativo";
  audit(q, w.nick, tipo, `${t.name}: ${motivo}`);
  s.json({ ok: true, aviso: tipo === "Exílio" ? "Exílio registrado. Remover do grupo no Roblox continua sendo manual." : null });
}));

// --- Auditoria com filtros: quem fez, quem foi afetado, tipo de ação, período. O IP só a CEx vê.
app.get("/api/audit", wrap((q, s, w) => {
  const { quem, afetado, acao, de, ate } = q.query, low = x => String(x || "").toLowerCase(), dia = /^\d{4}-\d{2}-\d{2}$/;
  let l = db.audit;
  if (quem) l = l.filter(x => low(x.quem).includes(low(quem)));
  if (afetado) l = l.filter(x => low(x.detalhe).includes(low(afetado)));
  if (acao) l = l.filter(x => x.acao === acao);
  if (dia.test(de || "")) l = l.filter(x => x.data >= new Date(de + "T00:00:00").toISOString());
  if (dia.test(ate || "")) l = l.filter(x => x.data <= new Date(ate + "T23:59:59").toISOString());
  s.json(l.slice(-300).reverse().map(x => w.sup ? x : { ...x, ip: undefined }));
}));

app.listen(process.env.PORT || 3000);
                            
