// Aviso geral e modo manutenção (controlados por você no /admin)
const { Config } = require('../models');
const { comCache, invalidar } = require('../utils/cache');

const CHAVE = 'sistema';

function lerConfig() {
  return comCache('config:sistema', 15 * 1000, async () => {
    const c = await Config.findOne({ chave: CHAVE }).lean();
    return c || { aviso: { ativo: false } };
  });
}

/**
 * Situação do aviso agora:
 *  - nada: nenhum aviso
 *  - programado: ainda não começou (mostra "manutenção programada para...")
 *  - vigente: está valendo agora
 * Depois do "fim", o aviso some sozinho.
 */
function situacaoDoAviso(aviso, agora = new Date()) {
  if (!aviso?.ativo || !aviso.mensagem) return 'nada';
  if (aviso.fim && agora >= new Date(aviso.fim)) return 'nada';
  if (aviso.inicio && agora < new Date(aviso.inicio)) return 'programado';
  return 'vigente';
}

async function avisoPublico() {
  const { aviso } = await lerConfig();
  const situacao = situacaoDoAviso(aviso);
  if (situacao === 'nada') return null;
  return {
    tipo: aviso.tipo,
    mensagem: aviso.mensagem,
    inicio: aviso.inicio,
    fim: aviso.fim,
    mostrarPara: aviso.mostrarPara,
    situacao,
    bloqueando: situacao === 'vigente' && aviso.tipo === 'manutencao' && aviso.bloquear,
    versao: new Date(aviso.atualizadoEm || 0).getTime(), // muda a cada alteração (para "fechar" a faixa)
  };
}

async function salvarAviso(dados) {
  await Config.updateOne(
    { chave: CHAVE },
    { $set: { aviso: { ...dados, atualizadoEm: new Date() } } },
    { upsert: true }
  );
  invalidar('config:sistema');
}

async function lerAvisoCompleto() {
  return (await lerConfig()).aviso || { ativo: false };
}

module.exports = { avisoPublico, salvarAviso, lerAvisoCompleto, situacaoDoAviso };
