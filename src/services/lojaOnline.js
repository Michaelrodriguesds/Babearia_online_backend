// Ligação com a Loja Online (o outro sistema): a agenda mostra alguns produtos da loja
// do negócio no rodapé e manda o cliente para a loja completa.
// A agenda conversa com a API PÚBLICA da loja pelo servidor (sem login, só leitura),
// então nada muda no código da loja e não tem problema de CORS.
const { lojaOnline } = require('../config/env');
const { comCacheSWR } = require('../utils/cache');
const { ErroApp } = require('../utils/erros');

const MAX_PRODUTOS = 8;
const CACHE_MS = 10 * 60 * 1000; // produtos ficam 10 min guardados (a loja não é consultada a cada visita)
const SLUG_VALIDO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Aceita o link da loja (https://virtualloja.netlify.app/loja/nome-da-loja) ou só o nome (nome-da-loja).
 * Só aceita lojas do SEU site de lojas: assim ninguém coloca link de outro site na agenda.
 */
function extrairSlug(texto) {
  const valor = String(texto || '').trim();
  if (!valor) return '';
  let slug = valor.toLowerCase();
  if (/^https?:\/\//i.test(valor) || valor.includes('/')) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(valor) ? valor : `https://${valor}`);
    } catch {
      throw new ErroApp(400, 'Link da loja inválido. Copie o link da sua loja e cole aqui.');
    }
    const site = new URL(lojaOnline.siteUrl);
    if (url.hostname.toLowerCase() !== site.hostname.toLowerCase()) {
      throw new ErroApp(400, `Só dá para ligar lojas do site ${site.hostname}.`);
    }
    const achado = /^\/loja\/([^/?#]+)/i.exec(url.pathname);
    if (!achado) throw new ErroApp(400, 'Esse link não é de uma loja. Ele precisa ter /loja/ e o nome da loja.');
    slug = decodeURIComponent(achado[1]).toLowerCase();
  }
  if (!SLUG_VALIDO.test(slug) || slug.length > 80) throw new ErroApp(400, 'Nome da loja inválido.');
  return slug;
}

async function buscarJson(caminho, tempoMs) {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), tempoMs);
  try {
    const r = await fetch(`${lojaOnline.apiUrl}${caminho}`, { signal: controle.signal, headers: { Accept: 'application/json' } });
    const corpo = await r.json().catch(() => null);
    return { status: r.status, corpo };
  } finally {
    clearTimeout(timer);
  }
}

const urlSegura = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

/** Confere se a loja existe (usado ao salvar no painel). Devolve { nome, disponivel } */
async function conferirLoja(slug) {
  let resp;
  try {
    resp = await buscarJson(`/publico/lojas/${encodeURIComponent(slug)}`, 20000); // a loja pode estar "acordando"
  } catch {
    return { nome: null, disponivel: null }; // não respondeu agora: salva mesmo assim
  }
  if (resp.status === 404) throw new ErroApp(400, 'Não encontramos essa loja. Confira o link.');
  if (resp.status === 403) return { nome: resp.corpo?.detalhes?.nome || null, disponivel: false };
  if (resp.status !== 200 || !resp.corpo) return { nome: null, disponivel: null };
  return { nome: resp.corpo.nome, disponivel: true };
}

/** Busca loja + produtos e devolve só o necessário para a vitrine da agenda */
async function carregarVitrine(slug) {
  const [loja, produtos] = await Promise.all([
    buscarJson(`/publico/lojas/${encodeURIComponent(slug)}`, 8000),
    buscarJson(`/publico/lojas/${encodeURIComponent(slug)}/produtos`, 8000),
  ]);
  const urlLoja = `${lojaOnline.siteUrl}/loja/${slug}`;
  // loja bloqueada, vencida ou apagada: vitrine some (fica guardado vazio por 10 min)
  if (loja.status !== 200 || produtos.status !== 200 || !Array.isArray(produtos.corpo)) {
    if (loja.status >= 500 || produtos.status >= 500) throw new Error('loja fora do ar');
    return { url: urlLoja, nome: null, produtos: [] };
  }
  const lista = produtos.corpo
    .filter((p) => p && p._id && p.nome && typeof p.preco === 'number')
    .map((p) => {
      const estoque = (p.variacoes || []).reduce((t, v) => t + (Number(v.estoque) || 0), 0);
      return {
        id: String(p._id),
        nome: String(p.nome).slice(0, 100),
        preco: Math.round(p.preco * 100) / 100,
        foto: urlSegura(p.fotos?.[0]),
        soNoLocal: !!p.soNoLocal,
        esgotado: !p.soNoLocal && (p.variacoes || []).length > 0 && estoque <= 0,
        url: `${urlLoja}/produto/${encodeURIComponent(String(p._id))}`,
      };
    })
    .filter((p) => !p.esgotado)
    .sort((a, b) => Number(!!b.foto) - Number(!!a.foto)) // com foto primeiro (mantém os mais novos na frente)
    .slice(0, MAX_PRODUTOS);
  return {
    url: urlLoja,
    nome: loja.corpo?.nome ? String(loja.corpo.nome).slice(0, 80) : null,
    logoUrl: urlSegura(loja.corpo?.logoUrl),
    produtos: lista,
  };
}

/** Vitrine com cache. Se a loja não responder, devolve vazio (a agenda nunca quebra por causa da loja) */
async function vitrineDaLoja(slug) {
  if (!slug) return null;
  try {
    return await comCacheSWR(`lojaOnline:${slug}`, CACHE_MS, () => carregarVitrine(slug));
  } catch {
    return { url: `${lojaOnline.siteUrl}/loja/${slug}`, nome: null, produtos: [] };
  }
}

module.exports = { extrairSlug, conferirLoja, vitrineDaLoja, carregarVitrine };
