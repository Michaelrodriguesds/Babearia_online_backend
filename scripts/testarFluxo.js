// Teste de ponta a ponta no SEU banco. Cria uma barbearia de teste,
// testa tudo e APAGA o que criou no final. Nenhuma mensagem real é enviada.
// Uso: npm run testar
const { DateTime } = require('luxon');
const mongoose = require('mongoose');
const config = require('../src/config/env');
config.whatsapp.token = ''; // força o modo simulado do WhatsApp durante o teste

const { Barbearia, Servico, Agendamento, Slot, Cliente } = require('../src/models');
const { conectarBanco } = require('../src/config/db');
const { horariosLivres, liberarExpirados } = require('../src/services/disponibilidade');
const servicoAgenda = require('../src/services/agendamentos');
const { statusLicenca, renovar, DIA_MS } = require('../src/services/licenca');

let passou = 0;
function conferir(condicao, descricao) {
  if (!condicao) throw new Error(`Falhou: ${descricao}`);
  passou++;
  console.log(`  ✔ ${descricao}`);
}

async function main() {
  await conectarBanco(config.mongoUri);
  const todosOsDias = [0, 1, 2, 3, 4, 5, 6].map((dia) => ({ dia, abre: '06:00', fecha: '23:00' }));

  const doc = await Barbearia.create({
    nome: 'Teste Automatico',
    slug: `teste-automatico-${Date.now()}`,
    whatsapp: '5521999990000',
    horarios: todosOsDias,
    regras: { antecedenciaMinMinutos: 0, minutosParaPagar: 15 },
    pagamento: { modo: 'manual', chavePix: 'teste@exemplo.com', nomeRecebedor: 'TESTE', cidade: 'RIO DE JANEIRO' },
    licenca: { plano: 'teste', acessoAte: new Date(Date.now() + 30 * DIA_MS) },
  });
  const b = doc.toObject();

  try {
    const servico = await Servico.create({ barbeariaId: b._id, nome: 'Corte', preco: 40, duracaoMinutos: 30 });
    const data = DateTime.now().setZone(config.fuso).plus({ days: 1 }).toISODate();

    console.log('\n1) Horários livres');
    const livres = await horariosLivres(b, 30, data);
    conferir(livres.length > 0, `${livres.length} horários livres amanhã`);
    const [h1, h2] = livres;

    console.log('\n2) Dois clientes tentam o MESMO horário ao mesmo tempo');
    const tentativas = await Promise.allSettled([
      servicoAgenda.criarAgendamento(b, { servicoId: servico._id, inicio: h1.inicio, nome: 'Cliente A', whatsapp: '21911110000' }),
      servicoAgenda.criarAgendamento(b, { servicoId: servico._id, inicio: h1.inicio, nome: 'Cliente B', whatsapp: '21922220000' }),
    ]);
    const ok = tentativas.filter((t) => t.status === 'fulfilled');
    const recusados = tentativas.filter((t) => t.status === 'rejected');
    conferir(ok.length === 1 && recusados[0]?.reason?.status === 409, 'só um conseguiu, o outro recebeu "horário indisponível"');
    const reserva = ok[0].value;
    conferir(reserva.status === 'pendente', 'reserva ficou pendente aguardando Pix');
    conferir(reserva.pix?.copiaCola?.startsWith('000201'), 'Pix copia e cola gerado com valor');

    const depois = await horariosLivres(b, 30, data);
    conferir(!depois.some((l) => l.inicio === h1.inicio), `horário ${h1.hora} sumiu da lista`);

    console.log('\n3) Confirmar pagamento e cancelar');
    const confirmado = await servicoAgenda.confirmarPagamento(reserva.id, { por: 'barbeiro' });
    conferir(confirmado.status === 'confirmado', 'pagamento confirmado');
    await servicoAgenda.cancelarAgendamento(await Agendamento.findById(reserva.id), 'barbeiro');
    const aposCancelar = await horariosLivres(b, 30, data);
    conferir(aposCancelar.some((l) => l.inicio === h1.inicio), 'cancelamento liberou o horário');

    console.log('\n4) Pix não pago no prazo');
    const r2 = await servicoAgenda.criarAgendamento(b, { servicoId: servico._id, inicio: h2.inicio, nome: 'Cliente C', whatsapp: '21933330000' });
    await Agendamento.updateOne({ _id: r2.id }, { $set: { expiraEm: new Date(Date.now() - 1000) } });
    await liberarExpirados(b._id);
    conferir((await Agendamento.findById(r2.id).lean()).status === 'expirado', 'reserva expirou');
    conferir((await Slot.countDocuments({ agendamentoId: r2.id })) === 0, 'horário liberado');

    const atrasado = await servicoAgenda.confirmarPagamento(r2.id, { por: 'webhook' });
    conferir(atrasado.status === 'confirmado', 'Pix pago atrasado recuperou o horário (estava livre)');

    console.log('\n5) Licença');
    await Barbearia.updateOne({ _id: b._id }, { $set: { 'licenca.acessoAte': new Date(Date.now() - 1000) } });
    const vencida = await Barbearia.findById(b._id).select('licenca').lean();
    conferir(!statusLicenca(vencida.licenca).ativa, 'plano vencido = bloqueado automaticamente');
    const renovada = await renovar(b._id, 30);
    conferir(renovada.ativa && renovada.diasRestantes === 30, 'renovação liberou +30 dias');

    console.log(`\n✅ ${passou} verificações passaram. Está tudo funcionando!\n`);
  } finally {
    await Promise.all([
      Agendamento.deleteMany({ barbeariaId: b._id }),
      Slot.deleteMany({ barbeariaId: b._id }),
      Servico.deleteMany({ barbeariaId: b._id }),
      Cliente.deleteMany({ barbeariaId: b._id }),
      Barbearia.deleteOne({ _id: b._id }),
    ]);
    console.log('🧹 Dados de teste apagados.');
    await mongoose.disconnect();
  }
}

main().catch((erro) => {
  console.error(`\n❌ ${erro.message}\n`);
  process.exit(1);
});
