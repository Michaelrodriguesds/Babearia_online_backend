// Todas as mensagens que o sistema manda.
// Os NOMES e TEXTOS dos templates estão no README — cadastre-os na Meta
// exatamente com esses nomes e com a mesma ordem de {{1}}, {{2}}...
const { DateTime } = require('luxon');
const { enviarTemplate } = require('./whatsapp');
const { enviarPush } = require('./push');
const { dataHoraBR, reais } = require('../utils/formatos');
const { frontendUrls, suporteWhatsapp, avisarBarbeiroWhatsapp, fuso } = require('../config/env');

const T = {
  PIX_CLIENTE: 'reserva_pix_cliente',
  CONFIRMADO_CLIENTE: 'agendamento_confirmado_cliente',
  AVISO_BARBEIRO: 'aviso_agendamento_barbeiro',
  EXPIRADO_CLIENTE: 'reserva_expirada_cliente',
  CANCELADO_CLIENTE: 'agendamento_cancelado_cliente',
  LEMBRETE_CLIENTE: 'lembrete_agendamento_cliente',
  LICENCA_BARBEIRO: 'aviso_plano_barbeiro',
};

const linkAgenda = (b) => `${frontendUrls[0]}/b/${b.slug}`;
const linkCancelar = (b, ag, codigo) => `${frontendUrls[0]}/b/${b.slug}/cancelar/${ag._id}?c=${codigo}`;

// Cliente reservou: recebe o Pix para pagar
function pixParaCliente(b, ag, pixTexto) {
  return enviarTemplate(ag.clienteWhatsapp, T.PIX_CLIENTE, [
    ag.clienteNome, b.nome, ag.servicoNome, dataHoraBR(ag.inicio),
    reais(ag.valorCobrado), b.regras.minutosParaPagar, pixTexto,
  ]);
}

// Pagamento confirmado (ou pagamento no local)
function confirmadoParaCliente(b, ag, codigo) {
  return enviarTemplate(ag.clienteWhatsapp, T.CONFIRMADO_CLIENTE, [
    ag.clienteNome, b.nome, ag.servicoNome, dataHoraBR(ag.inicio), b.endereco || '-',
    codigo ? linkCancelar(b, ag, codigo) : linkAgenda(b),
  ]);
}

// Barbeiro recebe tudo que é relevante: push grátis no celular
// e, se WHATSAPP_AVISAR_BARBEIRO=true, também pelo WhatsApp
function avisoBarbeiro(b, ag, situacao) {
  const dia = DateTime.fromJSDate(new Date(ag.inicio)).setZone(fuso).toISODate();
  enviarPush(b._id, {
    titulo: situacao,
    corpo: `${ag.clienteNome} • ${ag.servicoNome} • ${dataHoraBR(ag.inicio)} • R$ ${reais(ag.valorTotal)}`,
    url: `/painel?data=${dia}`,
  });
  if (!avisarBarbeiroWhatsapp) return Promise.resolve();
  return enviarTemplate(b.whatsapp, T.AVISO_BARBEIRO, [
    situacao, ag.clienteNome, ag.clienteWhatsapp, ag.servicoNome,
    dataHoraBR(ag.inicio), reais(ag.valorTotal), reais(ag.valorCobrado),
  ]);
}

function expiradoParaCliente(b, ag) {
  return enviarTemplate(ag.clienteWhatsapp, T.EXPIRADO_CLIENTE, [
    ag.clienteNome, b.nome, dataHoraBR(ag.inicio), linkAgenda(b),
  ]);
}

function canceladoParaCliente(b, ag) {
  return enviarTemplate(ag.clienteWhatsapp, T.CANCELADO_CLIENTE, [
    ag.clienteNome, b.nome, ag.servicoNome, dataHoraBR(ag.inicio), linkAgenda(b),
  ]);
}

function lembreteParaCliente(b, ag) {
  return enviarTemplate(ag.clienteWhatsapp, T.LEMBRETE_CLIENTE, [
    ag.clienteNome, b.nome, ag.servicoNome, dataHoraBR(ag.inicio), b.endereco || '-',
  ]);
}

function avisoPlanoBarbeiro(b, textoPrazo) {
  enviarPush(b._id, { titulo: `Seu plano ${textoPrazo}`, corpo: 'Toque para ver como renovar.', url: '/painel/plano' });
  return enviarTemplate(b.whatsapp, T.LICENCA_BARBEIRO, [
    b.nome, textoPrazo, dataHoraBR(b.licenca.acessoAte), suporteWhatsapp || '-',
  ]);
}

module.exports = {
  TEMPLATES: T,
  pixParaCliente, confirmadoParaCliente, avisoBarbeiro, expiradoParaCliente,
  canceladoParaCliente, lembreteParaCliente, avisoPlanoBarbeiro,
};
