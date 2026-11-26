// Robô da Netlivros na Cloudflare (Worker + D1 + Workers AI).
// Rotas: POST /telegram (webhook do @NetlivrosBot), POST /carga (carga inicial), POST /admin (importar/configurar), GET / (status).

const GRUPO_ID = -1005960503934;
const TOPICOS = {
  "Ficção e literatura": 4, "Romance": 5, "Ficção científica e fantasia": 6, "Mistério, suspense e terror": 7,
  "Autoajuda e desenvolvimento": 8, "Esoterismo e astrologia": 9, "Religião e espiritualidade": 10,
  "Psicologia e saúde mental": 11, "Saúde e medicina": 12, "Filosofia": 13, "Política e sociedade": 14,
  "Infantojuvenil": 15, "Educação e pedagogia": 16, "Negócios e finanças": 17, "História": 18,
  "Ciências e matemática": 19, "Biografias e memórias": 20, "Culinária": 21, "Poesia": 22,
  "Idiomas e referência": 23, "Arte, música e cinema": 24, "Direito": 25, "Tecnologia e informática": 26,
  "Quadrinhos e mangás": 27, "Adulto (+18)": 28, "Outros": 29,
};
const GENEROS = Object.keys(TOPICOS);
const SITE = "https://elrofs0.github.io/nossa-biblioteca/";
const CHAVE_HASH = "c300ce0510f4ed9b2e2918874b78992f8dd0de08c5b7da603a3b640dd0eb7a61"; // sha256 da chave de carga/admin
const chaveOk = async (c) => typeof c === "string" && (await sha256hex(c)) === CHAVE_HASH;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Content-Type": "application/json" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: CORS });

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS fontes (chat_id TEXT PRIMARY KEY, titulo TEXT, ativo INTEGER)`,
  `CREATE TABLE IF NOT EXISTS livros (id INTEGER PRIMARY KEY AUTOINCREMENT, fonte_chat TEXT, fonte_msg INTEGER, arquivo TEXT,
    titulo TEXT, autor TEXT, genero TEXT, tipo TEXT, tamanho TEXT, chave TEXT UNIQUE, file_unique_id TEXT, capa TEXT, sinopse TEXT,
    destino_msg INTEGER, status TEXT, busca TEXT, criado_em TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE (fonte_chat, fonte_msg))`,
  `CREATE INDEX IF NOT EXISTS livros_fuid ON livros (file_unique_id)`,
];
let pronto = false;
async function preparar(env) {
  if (pronto) return;
  await env.DB.batch(ESQUEMA.map((s) => env.DB.prepare(s)));
  pronto = true;
}
let tokenCache = null;
async function token(env) {
  if (env.TELEGRAM_BOT_TOKEN) return env.TELEGRAM_BOT_TOKEN;
  if (tokenCache) return tokenCache;
  const r = await env.DB.prepare("SELECT v FROM config WHERE k = 'token'").first();
  if (!r) throw new Error("token do robô não configurado");
  return (tokenCache = r.v);
}
async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function segredoWebhook(env) { return (await sha256hex("netlivros:" + (await token(env)))).slice(0, 48); }

async function tg(env, metodo, corpo) {
  const t = await token(env);
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetch(`https://api.telegram.org/bot${t}/${metodo}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
    });
    const j = await r.json();
    if (j.ok) return j.result;
    const espera = j.parameters?.retry_after;
    if (espera && tentativa < 2 && espera <= 20) { await new Promise((s) => setTimeout(s, (espera + 1) * 1000)); continue; }
    throw new Error(`Telegram ${metodo}: ${j.description}${espera ? ` (retry after ${espera})` : ""}`);
  }
  throw new Error(`Telegram ${metodo}: sem resposta`);
}

const sem = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const TIPOS = { pdf: "PDF", epub: "EPUB", mobi: "MOBI", azw3: "AZW3", azw: "AZW3", fb2: "FB2", djvu: "DJVU", doc: "DOC", docx: "DOC", txt: "TXT", rtf: "RTF" };
const PESSOAL = [/ctps/, /^(rg|cpf|cnh)\b/, /\b(rg|cpf|cnh) [a-z]+/, /^recibo/, /comprovante/, /^conta ?pdf|^contapdf/,
  /^fatura|fatura[_ -]?corsan|^extrato/, /conta de (agua|luz|energia|esgoto)/, /holerite|contracheque|rescisao/,
  /^exame-?\d|^atestados?\./, /^img[-_]\d/, /^vid[-_]\d/, /^curriculo/];
const ADULTO = [/contos? erotic/, /historias? erotic/, /memorias erotic/, /erotica/, /kama ?-?sutra/, /bdsm/, /sexo (anal|oral)/,
  /massagem[- ](erotica|sensual)/, /orgasmo/, /striptease/, /posicoes secretas/, /lugares para fazer sexo/, /manual do sexo/,
  /sexo selvagem/, /sexo tantrico|tantrico de amor|sexo-tantrico/, /porno chic/, /delta de venus/, /dono do sexo/, /cinquenta tons/];
function docWhatsappSemNome(s) {
  if (!/^doc[-_ ]?\d{6,}|-wa\d{4}/.test(s)) return false;
  const resto = s.replace(/\.(pdf|docx?|epub)$/, "").replace(/doc[-_ ]?\d+|-?wa\d+|\d+/g, " ");
  return !/[a-z]{3,}/.test(resto);
}
const ehPessoal = (nome) => { const s = sem(nome); return docWhatsappSemNome(s) || PESSOAL.some((p) => p.test(s)); };
const ehAdulto = (nome) => { const s = sem(nome); return !/funcao ?do ?orgasmo/.test(s) && ADULTO.some((p) => p.test(s)); };

function limparNome(arquivo) {
  let n = arquivo.replace(/\s*·\s*vers[aã]o\s*\d*$/i, "").trim();
  const m = n.match(/^(.*)\.([A-Za-z0-9]{2,5})$/);
  const ext = m ? m[2].toLowerCase() : "";
  let base = (m ? m[1] : n).replace(/_+/g, " ").replace(/\s*[([]?(@\w+|z-lib\S*|libgen\S*|www\.\S+)[)\]]?/gi, "").replace(/\s+/g, " ").trim().replace(/^[-. ]+|[-. ]+$/g, "");
  base = base.replace(/[–—]/g, "-");
  if (!base.includes(" ") && (base.match(/-/g) || []).length >= 2) base = base.replace(/-/g, " ");
  let autor = "";
  const a = base.match(/^(.+)\s+-\s+(.+?)$/), b = base.match(/^\[([^\]]{3,60})\]\s*(.+)$/), c = base.match(/^(.+?)\s*\(([^()\d]{4,50})\)$/);
  if (a && a[2].split(" ").length <= 8 && a[2].length > 2 && !/^\w{0,3}\d+\w*$/.test(a[2])) { base = a[1].trim(); autor = a[2].trim(); }
  else if (b) { autor = b[1].trim(); base = b[2].trim(); }
  else if (c && [2, 3, 4].includes(c[2].split(" ").length)) { base = c[1].trim(); autor = c[2].trim(); }
  if (base === base.toUpperCase() && base.length > 4) base = base.charAt(0) + base.slice(1).toLowerCase();
  return { titulo: base, autor, tipo: TIPOS[ext] || "", ext };
}
function chaveDe(titulo, autor, tipo) {
  const n = (s) => sem(s).replace(/\(\d+\)|\b(pdf|epub|vol|volume)\b/g, "").replace(/[^a-z0-9]/g, "");
  return `${n(titulo)}|${n(autor)}|${tipo}`;
}
const semLetras = (t) => !/[a-zà-ü]{3,}/i.test(sem(t));

async function ia(env, sistema, texto, max = 60) {
  const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
    messages: [{ role: "system", content: sistema }, { role: "user", content: texto }], max_tokens: max, temperature: 0,
  });
  return String(r.response || "").trim();
}
async function classificar(env, titulo, autor) {
  try {
    const txt = await ia(env, `Classifique o livro em UM destes gêneros e responda só o nome exato, sem mais nada:\n${GENEROS.join("\n")}\n"Romance" é romance amoroso; romance literário/clássico é "Ficção e literatura". Livros cristãos/espíritas vão em "Religião e espiritualidade"; tarô, astrologia, orixás e magia em "Esoterismo e astrologia". Se não for um livro (planilha, documento, atividade solta), responda "Outros".`,
      `${titulo}${autor ? " — " + autor : ""}`, 20);
    return GENEROS.find((g) => sem(txt).includes(sem(g))) || "Outros";
  } catch { return "Outros"; }
}
/** Arruma nomes de arquivo bagunçados ("♍Paulo Coelho - A Espia") quando a regra simples não basta. */
async function arrumarNome(env, arquivo, titulo, autor) {
  try {
    const txt = await ia(env, `Você recebe o nome de um arquivo de livro. Responda só JSON {"titulo":"...","autor":"..."} com o título e o autor corretos, em português quando o livro for em português, com maiúsculas normais e sem extensão, emojis, números de série ou nomes de sites. Se não souber o autor, use "". Se o nome não tiver um título de verdade (só números ou códigos), responda {"titulo":"","autor":""}.`,
      arquivo, 80);
    const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    if (typeof j.titulo === "string") return { titulo: j.titulo.trim(), autor: String(j.autor || "").trim() };
  } catch {}
  return { titulo, autor };
}

const pal = (s) => sem(s).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !["dos", "das", "para", "com", "uma", "por", "the"].includes(w));
async function buscarApple(titulo, autor, tid) {
  try {
    let x = null;
    if (tid) {
      x = (await (await fetch(`https://itunes.apple.com/lookup?country=br&id=${tid}`)).json()).results?.[0];
    } else {
      const t = titulo.replace(/\(.*?\)|\[.*?\]/g, "").trim(), tw = pal(t);
      if (!tw.length) return null;
      const r = await fetch(`https://itunes.apple.com/search?country=br&entity=ebook&limit=8&term=${encodeURIComponent((t + " " + autor).slice(0, 120))}`);
      if (r.status !== 200) return null;
      const todos = new Set([...tw, ...pal(autor)]);
      for (const y of (await r.json()).results || []) {
        const nw = pal(y.trackName); if (!nw.length) continue; const ns = new Set(nw);
        const hit = tw.filter((w) => ns.has(w)).length / tw.length, back = nw.filter((w) => todos.has(w)).length / nw.length;
        if ((hit >= 0.75 && back >= 0.4) || (back >= 0.85 && nw.length >= 2 && hit >= 0.3)) { x = y; break; }
      }
    }
    if (!x) return null;
    const sinopse = String(x.description || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
    return { capa: String(x.artworkUrl100 || "").replace("100x100bb", "600x900bb"), sinopse };
  } catch { return null; }
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hashtag = (g) => "#" + g.split(/[ ,]+/).filter((w) => !["e", "de"].includes(w)).map((w) => sem(w).replace(/[^a-z0-9]/g, "")).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
function legenda(l) {
  let s = `📖 <b>${esc(l.titulo)}</b>\n`;
  if (l.autor) s += `✍️ ${esc(l.autor)}\n`;
  s += `🏷️ ${hashtag(l.genero)}${l.tipo ? " · " + l.tipo : ""}\n`;
  const fim = `\n🔎 <a href="${SITE}">Ver no site</a> · @NetlivrosBot`;
  if (l.sinopse) {
    const espaco = 1000 - s.length - fim.length - 6;
    let t = l.sinopse.replace(/\s+/g, " ").trim();
    if (t.length > espaco) t = t.slice(0, espaco).replace(/\s+\S*$/, "") + "…";
    if (t.length > 40) s += `\n📝 ${esc(t)}\n`;
  }
  return s + fim;
}

async function processarArquivo(env, p) {
  if (!p.arquivo) return "sem nome";
  if (ehPessoal(p.arquivo)) return "pessoal (ignorado)";
  const nome = limparNome(p.arquivo);
  if (!nome.tipo) return "não é livro (" + nome.ext + ")";
  let titulo = p.titulo || nome.titulo, autor = p.autor ?? nome.autor;
  if (!p.titulo) ({ titulo, autor } = await arrumarNome(env, p.arquivo, titulo, autor));
  if (!titulo || semLetras(titulo)) return "sem título (aguardando nome)";
  const chave = chaveDe(titulo, autor, nome.tipo);
  // Três consultas com índice (um OR faria o D1 ler a tabela inteira a cada livro).
  const ja = await env.DB.prepare("SELECT id FROM livros WHERE chave = ?1 UNION ALL SELECT id FROM livros WHERE fonte_chat = ?2 AND fonte_msg = ?3 UNION ALL SELECT id FROM livros WHERE file_unique_id = ?4 LIMIT 1")
    .bind(chave, String(p.fonteChat), p.fonteMsg, p.fileUniqueId || "\u0000").first();
  if (ja) return "repetido (ignorado)";
  const genero = ehAdulto(p.arquivo) ? "Adulto (+18)" : (p.genero && TOPICOS[p.genero] ? p.genero : await classificar(env, titulo, autor));
  const apple = await buscarApple(titulo, autor, p.tid);
  const ins = await env.DB.prepare(`INSERT OR IGNORE INTO livros (fonte_chat, fonte_msg, arquivo, titulo, autor, genero, tipo, tamanho, chave, file_unique_id, capa, sinopse, status, busca)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'enviando', ?13)`)
    .bind(String(p.fonteChat), p.fonteMsg, p.arquivo, titulo, autor || "", genero, nome.tipo, String(p.tamanho || 0), chave,
      p.fileUniqueId || null, apple?.capa || p.capa || null, apple?.sinopse || null, sem(titulo + " " + (autor || ""))).run();
  if (!ins.meta.changes) return "repetido (ignorado)";
  const id = ins.meta.last_row_id;
  try {
    const r = await tg(env, "copyMessage", {
      chat_id: GRUPO_ID, from_chat_id: p.fonteChat, message_id: p.fonteMsg, message_thread_id: TOPICOS[genero],
      caption: legenda({ titulo, autor, genero, tipo: nome.tipo, sinopse: apple?.sinopse }), parse_mode: "HTML",
    });
    await env.DB.prepare("UPDATE livros SET destino_msg = ?1, status = 'publicado' WHERE id = ?2").bind(r.message_id, id).run();
    return `publicado em ${genero}`;
  } catch (e) {
    await env.DB.prepare("DELETE FROM livros WHERE id = ?1").bind(id).run();
    throw e;
  }
}

async function buscar(env, texto) {
  const termos = sem(texto).replace(/[%_]/g, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 6);
  if (!termos.length) return [];
  const where = termos.map((_, i) => `busca LIKE ?${i + 1}`).join(" AND ");
  const r = await env.DB.prepare(`SELECT titulo, autor, genero, destino_msg FROM livros WHERE status = 'publicado' AND ${where} LIMIT 8`)
    .bind(...termos.map((t) => `%${t}%`)).all();
  return r.results || [];
}

async function webhook(request, env) {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== (await segredoWebhook(env))) return json({ error: "proibido" }, 403);
  const u = await request.json().catch(() => null);
  if (!u || typeof u.update_id !== "number") return json({ ok: true });
  try {
    const mcm = u.my_chat_member;
    if (mcm && mcm.chat?.type === "channel" && mcm.chat.id !== GRUPO_ID) {
      const ativo = mcm.new_chat_member?.status === "administrator" ? 1 : 0;
      await env.DB.prepare("INSERT INTO fontes (chat_id, titulo, ativo) VALUES (?1, ?2, ?3) ON CONFLICT(chat_id) DO UPDATE SET ativo = ?3, titulo = ?2")
        .bind(String(mcm.chat.id), mcm.chat.title || "", ativo).run();
      return json({ ok: true });
    }
    const post = u.channel_post;
    if (post?.document) {
      const fonte = await env.DB.prepare("SELECT ativo FROM fontes WHERE chat_id = ?1").bind(String(post.chat.id)).first();
      if (!fonte?.ativo) return json({ ok: true });
      const d = post.document, nome = d.file_name || "";
      if (ehPessoal(nome)) return json({ ok: true });
      const res = await processarArquivo(env, { fonteChat: post.chat.id, fonteMsg: post.message_id, arquivo: nome, tamanho: d.file_size || 0, fileUniqueId: d.file_unique_id });
      console.log("livro", post.chat.id, post.message_id, nome, "→", res);
      return json({ ok: true });
    }
    const m = u.message;
    if (m?.chat?.type === "private" && typeof m.text === "string") {
      const texto = m.text.trim();
      if (/^\/(start|ajuda|help)/.test(texto)) {
        await tg(env, "sendMessage", { chat_id: m.chat.id, parse_mode: "HTML", text:
          "📚 <b>Olá! Eu sou o robô da Netlivros.</b>\n\nMe mande o <b>nome de um livro ou de um autor</b> que eu procuro no acervo e te mostro onde ele está no grupo.\n\nExemplos: <i>A menina que roubava livros</i> · <i>Augusto Cury</i> · <i>tarô</i>\n\n🔎 Com capas e sinopses: " + SITE });
        return json({ ok: true });
      }
      const achados = await buscar(env, texto);
      const linhas = achados.map((l) => `📖 <a href="https://t.me/c/${String(GRUPO_ID).replace("-100", "")}/${l.destino_msg}">${esc(l.titulo)}</a>${l.autor ? " — " + esc(l.autor) : ""}\n   🏷️ ${esc(l.genero)}`);
      await tg(env, "sendMessage", { chat_id: m.chat.id, parse_mode: "HTML", disable_web_page_preview: true, text: achados.length
        ? `Encontrei ${achados.length === 8 ? "estes (os 8 primeiros)" : "estes"}:\n\n${linhas.join("\n\n")}\n\nToque no título para abrir o livro no grupo.`
        : `Não achei "${esc(texto)}" no acervo. Tente só uma parte do título ou o sobrenome do autor.` });
    }
  } catch (e) { console.error("erro no webhook", e); }
  return json({ ok: true });
}

async function admin(request, env, base) {
  const b = await request.json();
  if (!(await chaveOk(b.chave))) return json({ error: "chave inválida" }, 403);
  if (b.acao === "token") {
    await env.DB.prepare("INSERT INTO config (k, v) VALUES ('token', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(b.token).run();
    tokenCache = null;
    return json({ ok: true });
  }
  if (b.acao === "fontes") {
    await env.DB.batch(b.fontes.map((f) => env.DB.prepare("INSERT OR REPLACE INTO fontes (chat_id, titulo, ativo) VALUES (?1, ?2, ?3)").bind(String(f.chat_id), f.titulo || "", f.ativo ? 1 : 0)));
    return json({ ok: true, n: b.fontes.length });
  }
  if (b.acao === "importar") {
    const st = env.DB.prepare(`INSERT OR IGNORE INTO livros (fonte_chat, fonte_msg, arquivo, titulo, autor, genero, tipo, tamanho, chave, file_unique_id, capa, destino_msg, status, busca, criado_em)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'publicado', ?13, ?14)`);
    const r = await env.DB.batch(b.livros.map((l) => st.bind(String(l.fonte_chat), l.fonte_msg, l.arquivo || "", l.titulo, l.autor || "", l.genero, l.tipo || "",
      String(l.tamanho || 0), l.chave, l.file_unique_id || null, l.capa || null, l.destino_msg, sem(l.titulo + " " + (l.autor || "")), l.criado_em || null)));
    return json({ ok: true, inseridos: r.reduce((s, x) => s + (x.meta.changes || 0), 0) });
  }
  if (b.acao === "webhook") {
    await tg(env, "setWebhook", { url: base + "/telegram", secret_token: await segredoWebhook(env), allowed_updates: ["message", "channel_post", "my_chat_member"] });
    await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Como usar o robô" }, { command: "ajuda", description: "Ajuda e exemplos de busca" }] });
    return json({ ok: true, info: await tg(env, "getWebhookInfo", {}) });
  }
  if (b.acao === "status") {
    const r = await env.DB.prepare("SELECT status, COUNT(*) n FROM livros GROUP BY status").all();
    const f = await env.DB.prepare("SELECT * FROM fontes").all();
    return json({ livros: r.results, fontes: f.results });
  }
  return json({ error: "ação desconhecida" }, 400);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
    try {
      await preparar(env);
      if (request.method === "POST" && url.pathname === "/telegram") return await webhook(request, env);
      if (request.method === "POST" && url.pathname === "/admin") return await admin(request, env, url.origin);
      if (request.method === "POST" && url.pathname === "/carga") {
        const b = JSON.parse(await request.text());
        if (!(await chaveOk(b.chave))) return json({ error: "chave inválida" }, 403);
        return json({ resultado: await processarArquivo(env, b.item) });
      }
      return json({ ok: true, app: "Netlivros" });
    } catch (e) {
      const msg = e?.message || String(e);
      const espera = /retry after (\d+)/i.exec(msg)?.[1];
      return json({ error: msg, retryAfter: espera ? Number(espera) : undefined }, 400);
    }
  },
};
