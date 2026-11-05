// Controle de licença: 1º mês grátis, depois o barbeiro paga você todo mês.
// O bloqueio é AUTOMÁTICO: toda requisição compara "acessoAte" com agora.
const { Barbearia } = require('../models');
const { comCache, invalidar } = require('../utils/cache');
const { diasPlano } = require('../config/env');
const { ErroApp } = require('../utils/erros');

const DIA_MS = 24 * 60 * 60 * 1000;

function statusLicenca(licenca) {
  const restanteMs = new Date(licenca.acessoAte).getTime() - Date.now();
  const ativa = restanteMs > 0;
  return {
    plano: licenca.plano,
    acessoAte: licenca.acessoAte,
    ativa,
    diasRestantes: ativa ? Math.ceil(restanteMs / DIA_MS) : 0,
    situacao: !ativa ? 'vencido' : restanteMs <= 3 * DIA_MS ? 'vencendo' : licenca.plano === 'teste' ? 'teste' : 'ativo',
  };
}

// Cache curto (1 min) para não consultar o banco em toda requisição
function licencaDaBarbearia(barbeariaId) {
  return comCache(`licenca:${barbeariaId}`, 60 * 1000, async () => {
    const b = await Barbearia.findById(barbeariaId).select('licenca').lean();
    if (!b) throw new ErroApp(404, 'Barbearia não encontrada');
    return b.licenca;
  });
}

// Renova somando dias: se ainda estava ativo, conta a partir do vencimento
// (o barbeiro não perde os dias que faltavam); se já venceu, conta de hoje.
async function renovar(barbeariaId, dias = diasPlano, observacao = '') {
  const b = await Barbearia.findById(barbeariaId);
  if (!b) throw new ErroApp(404, 'Barbearia não encontrada');

  const vencimento = new Date(b.licenca.acessoAte).getTime();
  const base = Math.max(vencimento, Date.now());
  b.licenca.acessoAte = new Date(base + dias * DIA_MS);
  b.licenca.plano = 'pago';
  b.licenca.ultimoAvisoEm = '';
  if (observacao) b.licenca.observacao = observacao;
  await b.save();

  invalidar(`licenca:${barbeariaId}`);
  return statusLicenca(b.licenca);
}

async function bloquearAgora(barbeariaId) {
  await Barbearia.updateOne({ _id: barbeariaId }, { $set: { 'licenca.acessoAte': new Date() } });
  invalidar(`licenca:${barbeariaId}`);
}

module.exports = { statusLicenca, licencaDaBarbearia, renovar, bloquearAgora, DIA_MS };
