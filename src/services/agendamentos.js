// Regras de agendamento: criar, confirmar pagamento, cancelar e bloquear agenda
const crypto = require('crypto');
const { DateTime } = require('luxon');
const { Agendamento, Slot, Servico, Cliente, Barbearia } = require('../models');
const { horariosLivres, fimDosBlocos, blocosEntre } = require('./disponibilidade');
const { gerarCobranca } = require('./pix');
const notificar = require('./notificacoes');
const { ErroApp, ehDuplicado } = require('../utils/erros');
const { normalizarTelefone } = require('../utils/formatos');
const { somarPrecos, calcularCobranca } = require('../utils/dinheiro');
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

const MAX_SERVICOS = 10;
const MAX_MINUTOS = 480; // 8 horas

/**
 * Busca os serviços escolhidos e soma tempo e preço (preço somado em centavos).
 * Aceita uma lista de ids; ids repetidos contam uma vez só. Mantém a ordem escolhida.
 */
async function carregarServicos(barbeariaId, servicoIds) {
  const ids = [...new Set((servicoIds || []).map(String))];
  if (!ids.length) throw new ErroApp(400, 'Escolha pelo menos um serviço.');
  if (ids.length > MAX_SERVICOS) throw new ErroApp(400, `Escolha no máximo ${MAX_SERVICOS} serviços por horário.`);
  const encontrados = await Servico.find({ _id: { $in: ids }, barbeariaId, ativo: true }).lean();
  if (encontrados.length !== ids.length) {
    throw new ErroApp(404, 'Um dos serviços escolhidos não está mais disponível. Atualize a página e escolha de novo.');
  }
  const porId = new Map(encontrados.map((x) => [String(x._id), x]));
  const servicos = ids.map((id) => porId.get(id));
  const duracaoMinutos = servicos.reduce((t, x) => t + x.duracaoMinutos, 0);
  if (duracaoMinutos > MAX_MINUTOS) throw new ErroApp(400, 'Os serviços escolhidos passam de 8 horas. Escolha menos serviços.');
  return {
    servicos,
    duracaoMinutos,
    preco: somarPrecos(servicos.map((x) => x.preco)),
    nome: servicos.map((x) => x.nome).join(' + '),
  };
}

/** Cliente agenda pela página pública (um ou vários serviços) */
async function criarAgendamento(barbearia, { servicoIds, inicio, nome, whatsapp, email }) {
  const escolha = await carregarServicos(barbearia._id, servicoIds);

  const dtInicio = DateTime.fromISO(inicio, { zone: fuso });
  if (!dtInicio.isValid) throw new ErroApp(400, 'Horário inválido.');

  // Confere se o horário pedido está livre com o tempo de TODOS os serviços somados
  const livres = await horariosLivres(barbearia, escolha.duracaoMinutos, dtInicio.toISODate());
  const disponivel = livres.some((l) => DateTime.fromISO(l.inicio).toMillis() === dtInicio.toMillis());
  if (!disponivel) throw new ErroApp(409, 'Esse horário não está mais disponível. Escolha outro.');

  const inicioData = dtInicio.toJSDate();
  const fimData = dtInicio.plus({ minutes: escolha.duracaoMinutos }).toJSDate();
  const valorCobrado = calcularCobranca(barbearia.regras, escolha.preco);
  const pagaNoLocal = valorCobrado <= 0;
  const telefone = normalizarTelefone(whatsapp);
  const codigo = crypto.randomBytes(12).toString('hex');

  const cliente = await salvarCliente(barbearia._id, nome.trim(), telefone, email);

  const ag = await Agendamento.create({
    barbeariaId: barbearia._id,
    tipo: 'cliente',
    servicoId: escolha.servicos[0]._id,
    servicoIds: escolha.servicos.map((x) => x._id),
    itens: escolha.servicos.map((x) => ({ servicoId: x._id, nome: x.nome, preco: x.preco, duracaoMinutos: x.duracaoMinutos })),
    servicoNome: escolha.nome,
    clienteId: cliente._id,
    clienteNome: cliente.nome,
    clienteWhatsapp: telefone,
    inicio: inicioData,
    fim: fimData,
    valorTotal: escolha.preco,
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
    servico: escolha.nome,
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

/**
 * Cliente avisa que já fez o Pix (modo chave Pix, sem confirmação automática).
 * A reserva para de expirar: fica segura até o horário do atendimento (no mínimo
 * 1 hora), e o barbeiro recebe um aviso para conferir e confirmar.
 * Pode ser chamado mais de uma vez sem problema.
 */
async function informarPagamento(ag) {
  if (ag.status !== 'pendente') throw new ErroApp(409, `Este agendamento já está ${ag.status}.`);
  if (ag.pagamento?.informadoEm) return ag;
  const segurarAte = Math.max(new Date(ag.inicio).getTime(), Date.now() + 60 * 60 * 1000);
  const r = await Agendamento.updateOne(
    { _id: ag._id, status: 'pendente' },
    { $set: { 'pagamento.informadoEm': new Date(), expiraEm: new Date(segurarAte) } }
  );
  if (!r.modifiedCount) throw new ErroApp(409, 'Este agendamento mudou de situação. Atualize a página.');
  const atualizado = await Agendamento.findById(ag._id);
  const barbearia = await Barbearia.findById(ag.barbeariaId).select('nome slug whatsapp').lean();
  notificar.avisoBarbeiro(barbearia, atualizado, 'Cliente informou que pagou o Pix: confira e confirme');
  return atualizado;
}

/** Cancela e libera o horário */
async function cancelarAgendamento(ag, por, motivo) {
  if (!['pendente', 'confirmado'].includes(ag.status)) {
    throw new ErroApp(409, `Este agendamento já está ${ag.status}.`);
  }
  const jaPago = Boolean(ag.pagamento?.pagoEm) && ag.valorCobrado > 0;
  ag.status = 'cancelado';
  ag.cancelamento = { por, em: new Date(), motivo: motivo ? String(motivo).trim().slice(0, 200) : undefined };
  await ag.save();
  await Slot.deleteMany({ agendamentoId: ag._id });

  const barbearia = await Barbearia.findById(ag.barbeariaId).select('nome slug whatsapp').lean();
  notificar.canceladoParaCliente(barbearia, ag);
  if (por === 'cliente') {
    const titulo = jaPago ? 'Cliente desistiu (Pix já pago: combine a devolução)' : 'Cliente desistiu do horário';
    notificar.avisoBarbeiro(barbearia, ag, ag.cancelamento.motivo ? `${titulo}: ${ag.cancelamento.motivo}` : titulo);
  }
  return { status: ag.status, jaPago };
}

/** Barbeiro marca que o cliente não apareceu (ou desfaz) */
async function marcarFalta(ag, desfazer = false) {
  if (desfazer) {
    if (ag.status !== 'faltou') throw new ErroApp(409, 'Este horário não está marcado como falta.');
    ag.status = 'concluido';
  } else {
    const jaComecou = new Date(ag.inicio).getTime() <= Date.now();
    if (!jaComecou || !['confirmado', 'concluido'].includes(ag.status)) {
      throw new ErroApp(409, 'Só dá para marcar falta em horário confirmado que já começou.');
    }
    ag.status = 'faltou';
  }
  await ag.save();
  return { status: ag.status };
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
  marcarFalta,
  carregarServicos, criarAgendamento, confirmarPagamento, informarPagamento, cancelarAgendamento, criarBloqueio, removerBloqueio, calcularCobranca,
};
