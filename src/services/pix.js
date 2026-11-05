// Escolhe como gerar o Pix conforme a configuração de cada barbearia
const { DateTime } = require('luxon');
const { Barbearia } = require('../models');
const { gerarPixCopiaCola } = require('../utils/pixEstatico');
const { descriptografar } = require('../utils/cripto');
const mercadoPago = require('./mercadoPago');
const { ErroApp } = require('../utils/erros');
const { apiUrl, pagadorEmailPadrao, fuso } = require('../config/env');

async function gerarCobranca(barbearia, agendamento, emailCliente) {
  const p = barbearia.pagamento || {};

  if (p.modo === 'mercadopago') {
    const comToken = await Barbearia.findById(barbearia._id).select('+pagamento.mpAccessTokenCripto').lean();
    const cripto = comToken?.pagamento?.mpAccessTokenCripto;
    if (!cripto) throw new ErroApp(400, 'Esta barbearia ainda não configurou o Mercado Pago.');

    const pix = await mercadoPago.criarPix({
      accessToken: descriptografar(cripto),
      valor: agendamento.valorCobrado,
      descricao: `${agendamento.servicoNome} - ${barbearia.nome}`,
      referencia: String(agendamento._id),
      emailPagador: emailCliente || pagadorEmailPadrao,
      expiraEm: DateTime.fromJSDate(agendamento.expiraEm).setZone(fuso).toISO(),
      urlNotificacao: `${apiUrl}/webhooks/mercadopago/${barbearia._id}`,
    });
    return { modo: 'mercadopago', ...pix };
  }

  // Modo manual: Pix copia e cola gerado a partir da chave do barbeiro
  if (!p.chavePix) throw new ErroApp(400, 'Esta barbearia ainda não cadastrou a chave Pix.');
  const copiaCola = gerarPixCopiaCola({
    chave: p.chavePix,
    valor: agendamento.valorCobrado,
    nome: p.nomeRecebedor || barbearia.nome,
    cidade: p.cidade || 'BRASIL',
    txid: String(agendamento._id),
  });
  return { modo: 'manual', copiaCola, chavePix: p.chavePix };
}

module.exports = { gerarCobranca };
