// Regras de agendamento: criar, confirmar pagamento, cancelar e bloquear agenda
const crypto = require('crypto');
const { DateTime } = require('luxon');
const { Agendamento, Slot, Servico, Cliente, Barbearia } = require('../models');
const { horariosLivres, fimDosBlocos, blocosEntre } = require('./disponibilidade');
const { gerarCobranca } = require('./pix');
const notificar = require('./notificacoes');
const { ErroApp, ehDuplicado } = require('../utils/erros');
const { normalizarTelefone } = require('../utils/formatos');
const { fuso, frontendUrls } = require('../config/env');

// Ocupa os blocos de 15 min. Se QUALQUER bloco já estiver ocupado, o índice
// único do banco recusa, desfazemos o que entrou e devolvemos false.
async function reservarBlocos(barbeariaId, agendamentoId, inicio, fim) {
  const docs = blocosEntre(inicio, fim).map((b) => ({ barbeariaId, agendamentoId, inicio: b }));
  try {
    await Slot.insertMany(docs, { ordered: true });
    return true;
  } catch (erro) {
    await Slot.deleteMany({ agendamentoId });
    if (ehDuplicado(erro)) return false;
    throw erro;
  }
}

// Quanto cobrar no Pix conforme a regra da barbearia
function calcularCobranca(regras, preco) {
  if (regras.cobranca === 'local') return 0;
  if (regras.cobranca === 'sinal') {
    const sinal = regras.sinalTipo === 'fixo' ? Math.min(regras.sinalValor, preco) : (preco * regras.sinalValor) / 100;
    return Math.round(sinal * 100) / 100;
  }
  return preco;
}

async function salvarCliente(barbeariaId, nome, whatsapp, email) {
  const filtro = { barbeariaId, whatsapp };
  const dados = { $set: { nome, ...(email ? { email } : {}) } };
  try {
    return await Cliente.findOneAndUpdate(filtro, dados, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  } catch (erro) {
    if (!ehDuplicado(erro)) throw erro; // dois agendamentos do mesmo cliente ao mesmo tempo
    return Cliente.findOneAndUpdate(filtro, dados, { new: true }).lean();
  }
}

function linkCancelamento(barbearia, agendamentoId, codigo) {
  return `${frontendUrls[0]}/b/${barbearia.slug}/cancelar/${agendamentoId}?c=${codigo}`;
}

/** Cliente agenda pela página pública */
async function criarAgendamento(barbearia, { servicoId, inicio, nome, whatsapp, email }) {
  const servico = await Servico.findOne({ _id: servicoId, barbeariaId: barbearia._id, ativo: true }).lean();
  if (!servico) throw new ErroApp(404, 'Serviço não encontrado.');

  const dtInicio = DateTime.fromISO(inicio, { zone: fuso });
  if (!dtInicio.isValid) throw new ErroApp(400, 'Horário inválido.');

  // Confere se o horário pedido realmente está livre e dentro das regras
  const livres = await horariosLivres(barbearia, servico.duracaoMinutos, dtInicio.toISODate());
  const disponivel = livres.some((l) => DateTime.fromISO(l.inicio).toMillis() === dtInicio.toMillis());
  if (!disponivel) throw new ErroApp(409, 'Esse horário não está mais disponível. Escolha outro.');

  const inicioData = dtInicio.toJSDate();
  const fimData = dtInicio.plus({ minutes: servico.duracaoMinutos }).toJSDate();
  const valorCobrado = calcularCobranca(barbearia.regras, servico.preco);
  const pagaNoLocal = valorCobrado <= 0;
  const telefone = normalizarTelefone(whatsapp);
  const codigo = crypto.randomBytes(12).toString('hex');

  const cliente = await salvarCliente(barbearia._id, nome.trim(), telefone, email);

  const ag = await Agendamento.create({
    barbeariaId: barbearia._id,
    tipo: 'cliente',
    servicoId: servico._id,
    servicoNome: servico.nome,
    clienteId: cliente._id,
    clienteNome: cliente.nome,
    clienteWhatsapp: telefone,
    inicio: inicioData,
    fim: fimData,
    valorTotal: servico.preco,
    valorCobrado,
    status: pagaNoLocal ? 'confirmado' : 'pendente',
    expiraEm: pagaNoLocal ? undefined : new Date(Date.now() + barbearia.regras.minutosParaPagar * 60 * 1000),
    pagamento: { modo: pagaNoLocal ? 'local' : barbearia.pagamento.modo },
    codigoCancelamento: codigo,
  });

  const reservou = await reservarBlocos(barbearia._id, ag._id, inicioData, fimDosBlocos(inicioData, fimData));
  if (!reservou) {
    await Agendamento.deleteOne({ _id: ag._id });
    throw new ErroApp(409, 'Alguém acabou de reservar esse horário. Escolha outro.');
  }
  await Cliente.updateOne({ _id: cliente._id }, { $inc: { totalAgendamentos: 1 } });

  let pix = null;
  if (!pagaNoLocal) {
    try {
      pix = await gerarCobranca(barbearia, ag, email);
    } catch (erro) {
      // sem Pix não existe reserva: devolve o horário
      await Slot.deleteMany({ agendamentoId: ag._id });
      await Agendamento.deleteOne({ _id: ag._id });
      throw erro;
    }
    ag.pagamento.pixCopiaCola = pix.copiaCola;
    ag.pagamento.mpPaymentId = pix.mpPaymentId;
    await ag.save();

    notificar.pixParaCliente(barbearia, ag, pix.copiaCola);
    if (pix.modo === 'manual') {
      // no modo manual o barbeiro precisa conferir o Pix e confirmar no painel
      notificar.avisoBarbeiro(barbearia, ag, 'Nova reserva: confira o Pix e confirme no painel');
    }
  } else {
    notificar.confirmadoParaCliente(barbearia, ag, codigo);
    notificar.avisoBarbeiro(barbearia, ag, 'Novo agendamento confirmado (pagamento no local)');
  }

  return {
    id: ag._id,
    status: ag.status,
    servico: servico.nome,
    inicio: ag.inicio,
    fim: ag.fim,
    valorTotal: ag.valorTotal,
    valorCobrado: ag.valorCobrado,
    expiraEm: ag.expiraEm || null,
    pix: pix ? { copiaCola: pix.copiaCola, qrCodeBase64: pix.qrCodeBase64 || null, chavePix: pix.chavePix || null } : null,
    codigo,
    linkCancelamento: linkCancelamento(barbearia, ag._id, codigo),
  };
}

/**
 * Confirma o pagamento (chamado pelo webhook do Mercado Pago ou pelo barbeiro).
 * Pode ser chamado mais de uma vez sem problema (idempotente).
 */
async function confirmarPagamento(agendamentoId, { por, mpPaymentId } = {}) {
  // updateOne com filtro "status: pendente" é atômico: só um confirma
  const r = await Agendamento.updateOne(
    { _id: agendamentoId, status: 'pendente' },
    {
      $set: {
        status: 'confirmado',
        'pagamento.pagoEm': new Date(),
        'pagamento.confirmadoPor': por,
        ...(mpPaymentId ? { 'pagamento.mpPaymentId': mpPaymentId } : {}),
      },
    }
  );
  const ag = await Agendamento.findById(agendamentoId).select('+codigoCancelamento');
  if (!ag) throw new ErroApp(404, 'Agendamento não encontrado.');

  if (!r.modifiedCount) {
    if (ag.status === 'confirmado') return ag; // já estava confirmado
    if (ag.status !== 'expirado') throw new ErroApp(409, `Não é possível confirmar um agendamento ${ag.status}.`);

    // Pix pago DEPOIS de expirar: tenta pegar o horário de volta.
    // Primeiro "trava" o agendamento para dois avisos iguais não fazerem isso ao mesmo tempo.
    const trava = await Agendamento.updateOne({ _id: ag._id, status: 'expirado' }, { $set: { status: 'conflito' } });
    if (!trava.modifiedCount) return Agendamento.findById(ag._id);
    const voltou = await reservarBlocos(ag.barbeariaId, ag._id, ag.inicio, fimDosBlocos(ag.inicio, ag.fim));
    ag.status = voltou ? 'confirmado' : 'conflito';
    ag.pagamento.pagoEm = new Date();
    ag.pagamento.confirmadoPor = por;
    await ag.save();
  }

  const barbearia = await Barbearia.findById(ag.barbeariaId).select('nome slug whatsapp endereco').lean();
  if (ag.status === 'confirmado') {
    notificar.confirmadoParaCliente(barbearia, ag, ag.codigoCancelamento);
    notificar.avisoBarbeiro(barbearia, ag, por === 'webhook' ? 'Pix recebido: agendamento confirmado' : 'Agendamento confirmado');
  } else {
    notificar.avisoBarbeiro(barbearia, ag, 'ATENÇÃO: Pix pago após o prazo e o horário já foi ocupado. Devolva o valor ou remarque');
  }
  return ag;
}

/** Cancela e libera o horário */
async function cancelarAgendamento(ag, por) {
  if (!['pendente', 'confirmado'].includes(ag.status)) {
    throw new ErroApp(409, `Este agendamento já está ${ag.status}.`);
  }
  const jaPago = Boolean(ag.pagamento?.pagoEm) && ag.valorCobrado > 0;
  ag.status = 'cancelado';
  await ag.save();
  await Slot.deleteMany({ agendamentoId: ag._id });

  const barbearia = await Barbearia.findById(ag.barbeariaId).select('nome slug whatsapp').lean();
  notificar.canceladoParaCliente(barbearia, ag);
  if (por === 'cliente') {
    notificar.avisoBarbeiro(barbearia, ag, jaPago ? 'Cliente cancelou (Pix já pago: combine a devolução)' : 'Cliente cancelou o agendamento');
  }
  return { status: ag.status, jaPago };
}

/** Barbeiro bloqueia um período (folga, compromisso, almoço diferente...) */
async function criarBloqueio(barbeariaId, { inicio, fim, motivo }) {
  const passo = 15 * 60 * 1000;
  const ini = DateTime.fromISO(inicio, { zone: fuso });
  const fi = DateTime.fromISO(fim, { zone: fuso });
  if (!ini.isValid || !fi.isValid || fi <= ini) throw new ErroApp(400, 'Período inválido.');
  if (fi.diff(ini, 'days').days > 14) throw new ErroApp(400, 'Bloqueie no máximo 14 dias por vez (para mais, use folgas).');

  const inicioData = new Date(Math.floor(ini.toMillis() / passo) * passo);
  const fimData = new Date(Math.ceil(fi.toMillis() / passo) * passo);

  const ag = await Agendamento.create({
    barbeariaId, tipo: 'bloqueio', status: 'bloqueado', motivo: motivo || 'Bloqueado', inicio: inicioData, fim: fimData,
  });
  const reservou = await reservarBlocos(barbeariaId, ag._id, inicioData, fimData);
  if (!reservou) {
    await Agendamento.deleteOne({ _id: ag._id });
    throw new ErroApp(409, 'Já existe agendamento nesse período. Cancele-o antes de bloquear.');
  }
  return ag;
}

async function removerBloqueio(barbeariaId, id) {
  const ag = await Agendamento.findOneAndDelete({ _id: id, barbeariaId, tipo: 'bloqueio' });
  if (!ag) throw new ErroApp(404, 'Bloqueio não encontrado.');
  await Slot.deleteMany({ agendamentoId: ag._id });
}

module.exports = {
  criarAgendamento, confirmarPagamento, cancelarAgendamento, criarBloqueio, removerBloqueio, calcularCobranca,
};
