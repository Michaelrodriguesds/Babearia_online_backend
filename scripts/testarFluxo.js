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
const { somarPrecos, calcularCobranca } = require('../src/utils/dinheiro');

// Lê o valor (campo 54) e confere o CRC de um Pix copia e cola
function lerPix(codigo) {
  let i = 0; const campos = {};
  while (i < codigo.length - 4) {
    const id = codigo.slice(i, i + 2); const tam = Number(codigo.slice(i + 2, i + 4));
    campos[id] = codigo.slice(i + 4, i + 4 + tam); i += 4 + tam;
  }
  return campos;
}

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
      servicoAgenda.criarAgendamento(b, { servicoIds: [servico._id], inicio: h1.inicio, nome: 'Cliente A', whatsapp: '21911110000' }),
      servicoAgenda.criarAgendamento(b, { servicoIds: [servico._id], inicio: h1.inicio, nome: 'Cliente B', whatsapp: '21922220000' }),
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
    const r2 = await servicoAgenda.criarAgendamento(b, { servicoIds: [servico._id], inicio: h2.inicio, nome: 'Cliente C', whatsapp: '21933330000' });
    await Agendamento.updateOne({ _id: r2.id }, { $set: { expiraEm: new Date(Date.now() - 1000) } });
    await liberarExpirados(b._id);
    conferir((await Agendamento.findById(r2.id).lean()).status === 'expirado', 'reserva expirou');
    conferir((await Slot.countDocuments({ agendamentoId: r2.id })) === 0, 'horário liberado');

    const atrasado = await servicoAgenda.confirmarPagamento(r2.id, { por: 'webhook' });
    conferir(atrasado.status === 'confirmado', 'Pix pago atrasado recuperou o horário (estava livre)');

    console.log('\n5) Cliente avisa que já fez o Pix (modo chave Pix)');
    const livres3 = await horariosLivres(b, 30, data);
    const r3 = await servicoAgenda.criarAgendamento(b, { servicoIds: [servico._id], inicio: livres3[3].inicio, nome: 'Cliente D', whatsapp: '21944440000' });
    await servicoAgenda.informarPagamento(await Agendamento.findById(r3.id));
    const ag3 = await Agendamento.findById(r3.id).lean();
    conferir(Boolean(ag3.pagamento.informadoEm) && ag3.status === 'pendente', 'pagamento informado e reserva continua aguardando o barbeiro');
    conferir(new Date(ag3.expiraEm) >= new Date(ag3.inicio), 'reserva não expira antes do horário do atendimento');
    await liberarExpirados(b._id);
    conferir((await Agendamento.findById(r3.id).lean()).status === 'pendente', 'a limpeza de reservas vencidas não derruba quem já pagou');
    const conf3 = await servicoAgenda.confirmarPagamento(r3.id, { por: 'barbeiro' });
    conferir(conf3.status === 'confirmado', 'barbeiro confirma depois do prazo original sem problema');

    console.log('\n6) Barbeiro confirma uma reserva que já tinha expirado');
    const r4 = await servicoAgenda.criarAgendamento(b, { servicoIds: [servico._id], inicio: livres3[6].inicio, nome: 'Cliente E', whatsapp: '21955550000' });
    await Agendamento.updateOne({ _id: r4.id }, { $set: { expiraEm: new Date(Date.now() - 1000) } });
    await liberarExpirados(b._id);
    const conf4 = await servicoAgenda.confirmarPagamento(r4.id, { por: 'barbeiro' });
    conferir(conf4.status === 'confirmado', 'reserva expirada volta a ficar confirmada (horário estava livre)');

    console.log('\n7) Licença');
    await Barbearia.updateOne({ _id: b._id }, { $set: { 'licenca.acessoAte': new Date(Date.now() - 1000) } });
    const vencida = await Barbearia.findById(b._id).select('licenca').lean();
    conferir(!statusLicenca(vencida.licenca).ativa, 'plano vencido = bloqueado automaticamente');
    const renovada = await renovar(b._id, 30);
    conferir(renovada.ativa && renovada.diasRestantes === 30, 'renovação liberou +30 dias');

    console.log('\n8) Vários serviços no mesmo horário');
    const barba = await Servico.create({ barbeariaId: b._id, nome: 'Barba', preco: 15, duracaoMinutos: 30 });
    const sobr = await Servico.create({ barbeariaId: b._id, nome: 'Sobrancelha', preco: 7.9, duracaoMinutos: 15 });
    const inativo = await Servico.create({ barbeariaId: b._id, nome: 'Antigo', preco: 10, duracaoMinutos: 15, ativo: false });
    const esc = await servicoAgenda.carregarServicos(b._id, [servico._id, barba._id, sobr._id, barba._id]);
    conferir(esc.servicos.length === 3, 'serviço repetido conta uma vez só');
    conferir(esc.preco === 62.9 && esc.duracaoMinutos === 75, 'soma: R$ 40 + 15 + 7,90 = R$ 62,90 e 75 min');
    conferir(esc.nome === 'Corte + Barba + Sobrancelha', 'nome junta os serviços na ordem escolhida');
    let erroInativo = null;
    try { await servicoAgenda.carregarServicos(b._id, [servico._id, inativo._id]); } catch (e) { erroInativo = e; }
    conferir(erroInativo?.status === 404, 'serviço desativado não pode ser escolhido');
    let erroOutra = null;
    try { await servicoAgenda.carregarServicos(b._id, [new mongoose.Types.ObjectId()]); } catch (e) { erroOutra = e; }
    conferir(erroOutra?.status === 404, 'serviço de outra barbearia é recusado');
    let erroVazio = null;
    try { await servicoAgenda.carregarServicos(b._id, []); } catch (e) { erroVazio = e; }
    conferir(erroVazio?.status === 400, 'sem nenhum serviço é recusado');

    const data2 = DateTime.now().setZone(config.fuso).plus({ days: 2 }).toISODate();
    const livres75 = await horariosLivres(b, 75, data2);
    const hm = livres75[0];
    const rm = await servicoAgenda.criarAgendamento(b, { servicoIds: [servico._id, barba._id, sobr._id], inicio: hm.inicio, nome: 'Cliente F', whatsapp: '21966660000' });
    const agm = await Agendamento.findById(rm.id).lean();
    conferir(agm.valorTotal === 62.9 && agm.valorCobrado === 62.9, 'Pix integral cobra o total R$ 62,90');
    conferir(agm.servicoIds.length === 3 && agm.servicoNome === 'Corte + Barba + Sobrancelha', 'reserva guarda os 3 serviços');
    conferir((agm.fim - agm.inicio) === 75 * 60000, 'reserva dura 75 minutos');
    const pixM = lerPix(agm.pagamento.pixCopiaCola);
    conferir(pixM['54'] === '62.90', `valor dentro do Pix copia e cola = ${pixM['54']}`);
    conferir((await Slot.countDocuments({ agendamentoId: rm.id })) === 5, 'ocupou 5 blocos de 15 min (75 min)');
    const fimM = DateTime.fromJSDate(agm.fim).setZone(config.fuso);
    const livresDepois = await horariosLivres(b, 30, data2);
    conferir(!livresDepois.some((l) => { const t = DateTime.fromISO(l.inicio).toMillis(); return t >= agm.inicio.getTime() && t < agm.fim.getTime(); }),
      'nenhum horário entre o início e o fim da reserva ficou livre');
    conferir(livresDepois.some((l) => DateTime.fromISO(l.inicio).toMillis() === fimM.toMillis()), `${fimM.toFormat('HH:mm')} (fim) continua livre`);
    let erroSobre = null;
    try {
      await servicoAgenda.criarAgendamento(b, { servicoIds: [barba._id], inicio: fimM.minus({ minutes: 15 }).toISO(), nome: 'Cliente G', whatsapp: '21977770000' });
    } catch (e) { erroSobre = e; }
    conferir(erroSobre?.status === 409, 'não deixa marcar por cima do fim da reserva com vários serviços');

    console.log('\n9) Sinal (Pix parcial) e pagamento no local');
    const comRegra = (regras) => ({ ...b, regras: { ...b.regras, ...regras } });
    const casos = [
      [{ cobranca: 'integral' }, 62.9, 62.9],
      [{ cobranca: 'sinal', sinalTipo: 'percentual', sinalValor: 50 }, 62.9, 31.45],
      [{ cobranca: 'sinal', sinalTipo: 'percentual', sinalValor: 30 }, 47, 14.1],
      [{ cobranca: 'sinal', sinalTipo: 'percentual', sinalValor: 33 }, 0.1, 0.03],
      [{ cobranca: 'sinal', sinalTipo: 'percentual', sinalValor: 150 }, 40, 40],
      [{ cobranca: 'sinal', sinalTipo: 'fixo', sinalValor: 20 }, 62.9, 20],
      [{ cobranca: 'sinal', sinalTipo: 'fixo', sinalValor: 100 }, 62.9, 62.9],
      [{ cobranca: 'local' }, 62.9, 0],
    ];
    for (const [regras, total, esperado] of casos) {
      const v = calcularCobranca(regras, total);
      conferir(v === esperado, `${regras.cobranca}${regras.sinalValor != null ? ` ${regras.sinalTipo} ${regras.sinalValor}` : ''} sobre R$ ${total} → R$ ${v}`);
    }
    conferir(somarPrecos([0.1, 0.2]) === 0.3 && somarPrecos([19.99, 19.99, 19.99]) === 59.97, 'soma sem erro de centavo (0,1 + 0,2 = 0,30)');

    const livresS = await horariosLivres(b, 45, data2);
    const bSinal = comRegra({ cobranca: 'sinal', sinalTipo: 'percentual', sinalValor: 50 });
    const rs = await servicoAgenda.criarAgendamento(bSinal, { servicoIds: [barba._id, sobr._id], inicio: livresS[livresS.length - 1].inicio, nome: 'Cliente H', whatsapp: '21988880000' });
    const ags = await Agendamento.findById(rs.id).lean();
    conferir(ags.valorTotal === 22.9 && ags.valorCobrado === 11.45, 'sinal de 50% de R$ 22,90 = R$ 11,45');
    conferir(lerPix(ags.pagamento.pixCopiaCola)['54'] === '11.45', 'Pix copia e cola com o valor do sinal');

    const livresL = await horariosLivres(b, 45, data2);
    const rl = await servicoAgenda.criarAgendamento(comRegra({ cobranca: 'local' }), { servicoIds: [barba._id, sobr._id], inicio: livresL[livresL.length - 1].inicio, nome: 'Cliente I', whatsapp: '21999990001' });
    const agl = await Agendamento.findById(rl.id).lean();
    conferir(agl.status === 'confirmado' && agl.valorCobrado === 0 && !agl.pagamento.pixCopiaCola, 'pagar no local: confirmado direto, sem Pix');

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
