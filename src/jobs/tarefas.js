// Tarefas automáticas (rodam sozinhas enquanto a API estiver ligada)
const cron = require('node-cron');
const { Agendamento, Barbearia } = require('../models');
const { liberarExpirados } = require('../services/disponibilidade');
const { statusLicenca, DIA_MS } = require('../services/licenca');
const notificar = require('../services/notificacoes');
const { hojeISO } = require('../utils/formatos');
const { fuso } = require('../config/env');

const HORA_MS = 60 * 60 * 1000;

async function barbeariasPorId(ids) {
  const lista = await Barbearia.find({ _id: { $in: [...new Set(ids.map(String))] } }).select('nome slug endereco regras').lean();
  return new Map(lista.map((b) => [String(b._id), b]));
}

// Lembretes 24h e 2h antes + marca como concluído o que já passou
async function enviarLembretes() {
  const agora = Date.now();

  const em24h = await Agendamento.find({
    status: 'confirmado', lembrete24hEnviado: false,
    inicio: { $gt: new Date(agora + 20 * HORA_MS), $lte: new Date(agora + 24 * HORA_MS) },
  }).lean();

  const em2h = await Agendamento.find({
    status: 'confirmado', lembrete2hEnviado: false,
    inicio: { $gt: new Date(agora), $lte: new Date(agora + 2 * HORA_MS) },
    createdAt: { $lt: new Date(agora - 30 * 60 * 1000) }, // não lembra quem acabou de agendar
  }).lean();

  // Cada barbearia escolhe quais lembretes quer (cada mensagem tem custo)
  const barbearias = await barbeariasPorId([...em24h, ...em2h].map((a) => a.barbeariaId));
  for (const ag of em24h) {
    const b = barbearias.get(String(ag.barbeariaId));
    if (b && b.regras?.lembrete24h !== false) notificar.lembreteParaCliente(b, ag);
  }
  for (const ag of em2h) {
    const b = barbearias.get(String(ag.barbeariaId));
    if (b && b.regras?.lembrete2h) notificar.lembreteParaCliente(b, ag);
  }

  if (em24h.length) await Agendamento.updateMany({ _id: { $in: em24h.map((a) => a._id) } }, { $set: { lembrete24hEnviado: true } });
  if (em2h.length) await Agendamento.updateMany({ _id: { $in: em2h.map((a) => a._id) } }, { $set: { lembrete2hEnviado: true, lembrete24hEnviado: true } });

  await Agendamento.updateMany({ status: 'confirmado', fim: { $lt: new Date(agora) } }, { $set: { status: 'concluido' } });
}

// Avisa o barbeiro 3 dias antes, 1 dia antes e no dia em que o plano vence
async function avisarPlanos() {
  const hoje = hojeISO();
  const agora = Date.now();
  const barbearias = await Barbearia.find({
    'licenca.acessoAte': { $gt: new Date(agora - DIA_MS), $lte: new Date(agora + 3 * DIA_MS) },
    'licenca.ultimoAvisoEm': { $ne: hoje },
  }).select('nome whatsapp licenca').lean();

  for (const b of barbearias) {
    const st = statusLicenca(b.licenca);
    let texto = null;
    if (!st.ativa) texto = 'venceu';
    else if (st.diasRestantes === 1) texto = 'vence amanhã';
    else if (st.diasRestantes === 3) texto = 'vence em 3 dias';
    if (!texto) continue;
    await notificar.avisoPlanoBarbeiro(b, texto);
    await Barbearia.updateOne({ _id: b._id }, { $set: { 'licenca.ultimoAvisoEm': hoje } });
  }
}

function seguro(nome, fn) {
  return () => fn().catch((erro) => console.error(`❌ Tarefa "${nome}" falhou:`, erro.message));
}

function iniciarTarefas() {
  cron.schedule('* * * * *', seguro('liberar expirados', liberarExpirados), { timezone: fuso });
  cron.schedule('*/10 * * * *', seguro('lembretes', enviarLembretes), { timezone: fuso });
  cron.schedule('0 9 * * *', seguro('avisos de plano', avisarPlanos), { timezone: fuso });
  console.log('⏰ Tarefas automáticas iniciadas');
}

module.exports = { iniciarTarefas, enviarLembretes, avisarPlanos };
