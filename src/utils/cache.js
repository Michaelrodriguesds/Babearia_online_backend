// Cache em memória (melhoria do Glamour).
//  - comCache: devolve do cache até vencer o tempo (TTL). Usado na licença.
//  - comCacheSWR: "stale-while-revalidate" — devolve o valor guardado na hora
//    e atualiza em segundo plano. Usado em dados que mudam pouco
//    (página pública, serviços). NUNCA use para horários livres.
const guardado = new Map();

async function comCache(chave, ttlMs, carregar) {
  const item = guardado.get(chave);
  if (item && Date.now() - item.em < ttlMs) return item.valor;
  const valor = await carregar();
  guardado.set(chave, { valor, em: Date.now() });
  return valor;
}

async function comCacheSWR(chave, ttlMs, carregar) {
  const item = guardado.get(chave);
  if (!item) {
    const valor = await carregar();
    guardado.set(chave, { valor, em: Date.now() });
    return valor;
  }
  if (Date.now() - item.em > ttlMs && !item.atualizando) {
    item.atualizando = true;
    carregar()
      .then((valor) => guardado.set(chave, { valor, em: Date.now() }))
      .catch(() => { item.atualizando = false; });
  }
  return item.valor;
}

// Apaga tudo que começa com o prefixo. Ex.: invalidar(`barbearia:${id}`)
function invalidar(prefixo) {
  for (const chave of guardado.keys()) if (chave.startsWith(prefixo)) guardado.delete(chave);
}

module.exports = { comCache, comCacheSWR, invalidar };
