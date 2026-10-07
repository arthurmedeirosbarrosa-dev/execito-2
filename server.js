// Servidor do painel — login oficial do Roblox (OAuth), igual ao Rover.
// Requer Node 18+ e: npm i express
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
const pending  = new Map();   // state  -> return URL (anti-CSRF do login)
const oneTime  = new Map();   // authcode -> token (troca única depois do redirect)

const j = (u, o) => fetch(u, o).then(r => r.json());

// 1) Manda a pessoa para a tela OFICIAL do Roblox. A senha é digitada lá, nunca no nosso site.
app.get("/auth/start", (q, s) => {
  const state = crypto.randomUUID();
  pending.set(state, true);
  setTimeout(() => pending.delete(state), 10 * 60000);
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
app.get("/auth/callback", async (q, s) => {
  try {
    const { code, state } = q.query;
    if (!pending.has(state)) return s.status(400).send("Login expirado, volte ao site e tente de novo.");
    pending.delete(state);

    const tok = await j("https://apis.roblox.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CID, client_secret: CSECRET,
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI
      })
    });
    if (!tok.access_token) return s.status(400).send("O Roblox recusou o login.");

    const me = await j("https://apis.roblox.com/oauth/v1/userinfo", {
      headers: { Authorization: "Bearer " + tok.access_token }
    });

    const session = crypto.randomUUID();
    sessions.set(session, { id: me.sub, nick: me.preferred_username });

    const authcode = Math.random().toString(36).slice(2, 6).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    oneTime.set(authcode, session);
    setTimeout(() => oneTime.delete(authcode), 10 * 60000); // expira em 10 min se não for usado

    s.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login feito</title>
<style>body{font-family:sans-serif;background:#141a11;color:#e8ecdc;text-align:center;padding:40px 20px}
code{display:inline-block;font-size:1.8rem;letter-spacing:2px;background:#1d2619;border:1px solid #34422d;
border-radius:6px;padding:14px 22px;margin:18px 0;color:#6aa55c;font-weight:700}
button{padding:10px 18px;border:0;border-radius:4px;background:#6aa55c;color:#0d140a;font-weight:700;font-size:1rem}
p{max-width:420px;margin:10px auto;line-height:1.5}</style></head><body>
<h2>Login feito, ${me.preferred_username}!</h2>
<p>Volte para a aba do site do Exército Brasileiro e cole este código onde pedir:</p>
<code id="c">${authcode}</code><br>
<button onclick="navigator.clipboard.writeText(document.getElementById('c').textContent);this.textContent='Copiado!'">Copiar código</button>
<p>Esse código vale por 10 minutos. Depois disso pode fechar esta aba.</p>
</body></html>`);
  } catch (e) { s.status(500).send("Falha ao falar com o Roblox."); }
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
  s.json({ token: session, nick: me.nick, label: r.name, isSuper: sup,
           avatar: await avatar(me.id), cdp: cdpInfo(me.id, r.id, sup) });
});

// Atualiza o cabeçalho (patente + CDP) sem precisar logar de novo. O site chama a cada ~30s.
app.get("/api/me", async (q, s) => {
  try {
    const me = sessions.get(q.query.token);
    if (!me) return s.json({ error: "Sessão inválida. Entre de novo." });
    const r = await role(me.id);
    if (!r) return s.json({ error: "Você não está no grupo do jogo." });
    const sup = isSuper(me.nick, r.name);
    s.json({ nick: me.nick, label: r.name, isSuper: sup, avatar: await avatar(me.id), cdp: cdpInfo(me.id, r.id, sup) });
  } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); }
});

// Lista pública das patentes do grupo, para preencher a lista de escolha do CEx/SGEx no site.
app.get("/api/roles", (q, s) => s.json(LADDER));
app.get("/api/cdp", (q, s) => s.json(CDP_HORAS));

app.get("/auth/logout", (q, s) => s.redirect(q.query.return || SITE_ORIGIN));

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

// A patente de quem promove vem da sessão (logada no Roblox), nunca do navegador.
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
    const curIdx = LADDER.findIndex(x => x.id === cur.id);

    let next;
    if (meSuper && q.body.toRoleId) {
      next = LADDER.find(x => String(x.id) === String(q.body.toRoleId));
      if (!next) return s.json({ error: "Patente escolhida não existe." });
      if (next.id === cur.id) return s.json({ error: "Esse militar já está nessa patente." });
    } else {
      if (curIdx === -1) return s.json({ error: "Esse militar está num cargo fora da escada de patentes." });
      next = LADDER[curIdx + 1];
      const topIdx = LADDER.findIndex(x => x.name === AUTO_TOP_NAME);
      if (!next || curIdx + 1 > topIdx) return s.json({ error: "Patente máxima alcançável por promoção." });
      const mineIdx = LADDER.findIndex(x => x.id === mine.id);
      if (mineIdx === -1 || mineIdx <= curIdx + 1) return s.json({ error: "Sua patente precisa ser maior que " + next.name + "." });
    }

    // Poder total (CEx, SGEx, Creator, Sub Creator) não espera CDP.
    // Os demais esperam o CDP do cargo para o qual o militar está subindo.
    const cdpMs = (CDP_HORAS[next.name] || 0) * 3600000;
    if (!meSuper && cdpMs) {
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

    lastPromo.set(String(t.id), Date.now());
    s.json({ nick: t.name, from: cur.name, to: next.name, note: CDP_NOTAS[next.name] || null });
  } catch (e) { s.json({ error: "Falha ao falar com o Roblox." }); }
});

app.listen(process.env.PORT || 3000);
