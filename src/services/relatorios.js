// Números do negócio para o dono: movimento, clientes, serviços que mais rendem.
// Contas de dinheiro em centavos inteiros (sem erro de arredondamento).
// Atendimento "realizado" = concluído, ou confirmado cujo horário já começou.
// Faturamento = valor total dos serviços (Pix + o que foi pago no local).
const { DateTime } = require('luxon');
const { Agendamento, Servico, Cliente } = require('../models');
const { fuso } = require('../config/env');

const DIAS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const DIAS_SUMIDO = 30;

const centavos = (reais) => Math.round(Number(reais || 0) * 100);
const reais = (c) => c / 100;
const DIA_MS = 86400000;

/** Divide um total em partes proporcionais aos pesos, sem perder nenhum centavo */
function dividirProporcional(totalCentavos, pesos) {
  const somaPesos = pesos.reduce((a, b) => a + b, 0);
  if (somaPesos <= 0) return pesos.map((_, i) => (i === 0 ? totalCentavos : 0));
  const brutos = pesos.map((p) => (totalCentavos * p) / somaPesos);
  const partes = brutos.map(Math.floor);
  let resto = totalCentavos - partes.reduce((a, b) => a + b, 0);
  const ordem = brutos.map((b, i) => [b - Math.floor(b), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; resto > 0; k = (k + 1) % ordem.length, resto -= 1) partes[ordem[k][1]] += 1;
  return partes;
}

/** Quanto cada serviço do agendamento rendeu (soma sempre bate com o valor total) */
function itensDoAgendamento(ag, precosAtuais) {
  const total = centavos(ag.valorTotal);
  if (ag.itens?.length) {
    const valores = dividirProporcional(total, ag.itens.map((i) => centavos(i.preco)));
    return ag.itens.map((i, k) => ({ chave: String(i.servicoId || i.nome), nome: i.nome, valor: valores[k] }));
  }
  // Reservas antigas (antes de guardar o preço de cada serviço): usa os serviços atuais como peso
  const ids = (ag.servicoIds?.length ? ag.servicoIds : [ag.servicoId]).filter(Boolean).map(String);
  const servicos = ids.map((id) => precosAtuais.get(id));
  if (ids.length > 1 && servicos.every(Boolean)) {
    const valores = dividirProporcional(total, servicos.map((s) => centavos(s.preco)));
    return servicos.map((s, k) => ({ chave: String(s._id), nome: s.nome, valor: valores[k] }));
  }
  return [{ chave: ids[0] || ag.servicoNome, nome: (ids.length === 1 && servicos[0]?.nome) || ag.servicoNome || 'Serviço', valor: total }];
}

const chaveCliente = (ag) => String(ag.clienteId || ag.clienteWhatsapp || ag.clienteNome);

function gerarDicas(r) {
  const dicas = [];
  if (!r.resumo.atendimentos) return dicas;
  const comMovimento = r.porDiaSemana.filter((d) => d.atendimentos > 0);
  if (comMovimento.length >= 2) {
    const ordem = [...comMovimento].sort((a, b) => b.atendimentos - a.atendimentos);
    const forte = ordem[0];
    const fraco = ordem[ordem.length - 1];
    if (forte.atendimentos > fraco.atendimentos) {
      dicas.push(`Seu dia mais movimentado é ${forte.dia.toLowerCase()} e o mais fraco é ${fraco.dia.toLowerCase()}. Uma promoção para ${fraco.dia.toLowerCase()} pode encher a agenda.`);
    }
  }
  if (r.porHora.length) {
    const pico = [...r.porHora].sort((a, b) => b.atendimentos - a.atendimentos)[0];
    dicas.push(`O horário mais procurado é ${pico.hora}. Deixe ele livre para quem marca primeiro e divulgue os horários mais vazios.`);
  }
  if (r.servicos.length) {
    const top = r.servicos[0];
    dicas.push(`${top.nome} é o que mais rende: ${top.percentual}% do faturamento. Vale destacar esse serviço na divulgação.`);
  }
  if (r.sumidos.length) {
    dicas.push(`${r.sumidos.length === 1 ? '1 cliente fixo não volta' : `${r.sumidos.length} clientes fixos não voltam`} há mais de ${DIAS_SUMIDO} dias. Mande uma mensagem chamando de volta: tem um botão pronto na lista.`);
  }
  if (r.retorno.diasEntreVisitas) {
    dicas.push(`Seus clientes que voltam costumam voltar a cada ${r.retorno.diasEntreVisitas} dias. Um lembrete perto dessa data ajuda a não perder o cliente.`);
  }
  const { desistencias, faltas, taxaPerda } = r.perdas;
  if (taxaPerda >= 15 && desistencias + faltas >= 3) {
    dicas.push(`${taxaPerda}% dos horários marcados não viraram atendimento (desistências e faltas). Cobrar um sinal no Pix ajuda a reduzir isso.`);
  }
  return dicas;
}

/**
 * @param barbeariaId
 * @param {{ dias: number, agora?: Date }} opcoes período em dias (30, 90, 365); "agora" serve para os testes
 */
async function gerarRelatorio(barbeariaId, { dias = 90, agora: agoraTeste } = {}) {
  const agora = agoraTeste ? DateTime.fromJSDate(agoraTeste).setZone(fuso) : DateTime.now().setZone(fuso);
  const agoraMs = agora.toMillis();
  const desde = agora.minus({ days: dias }).startOf('day');
  const primeiroMes = agora.startOf('month').minus({ months: 11 });
  // Busca pelo menos 12 meses (gráfico de meses e clientes sumidos), ou o período, o que for maior
  const buscarDesde = desde < primeiroMes ? desde : primeiroMes;

  const [ags, servicos, clientes] = await Promise.all([
    Agendamento.find({ barbeariaId, tipo: 'cliente', inicio: { $gte: buscarDesde.toJSDate(), $lte: agora.plus({ days: 400 }).toJSDate() } })
      .select('clienteId clienteNome clienteWhatsapp servicoId servicoIds servicoNome itens inicio expiraEm valorTotal valorCobrado status cancelamento pagamento.pagoEm')
      .lean(),
    Servico.find({ barbeariaId }).select('nome preco').lean(),
    Cliente.find({ barbeariaId }).select('nome whatsapp createdAt').lean(),
  ]);
  const precosAtuais = new Map(servicos.map((s) => [String(s._id), s]));
  const clientePorId = new Map(clientes.map((c) => [String(c._id), c]));

  const realizado = (a) => a.status === 'concluido' || (a.status === 'confirmado' && new Date(a.inicio).getTime() <= agoraMs);
  const noPeriodo = (a) => {
    const t = new Date(a.inicio).getTime();
    return t >= desde.toMillis() && t <= agoraMs;
  };

  // ---------- Resumo e perdas do período ----------
  const realizadosPeriodo = ags.filter((a) => realizado(a) && noPeriodo(a));
  const faturamento = realizadosPeriodo.reduce((t, a) => t + centavos(a.valorTotal), 0);
  const recebidoPix = realizadosPeriodo.reduce((t, a) => t + (a.pagamento?.pagoEm ? centavos(a.valorCobrado) : 0), 0);
  const atendimentos = realizadosPeriodo.length;

  // Perdas contam pela data em que aconteceram (a desistência de um horário futuro conta hoje)
  const quandoAconteceu = (a) => {
    if (a.status === 'cancelado' && a.cancelamento?.em) return new Date(a.cancelamento.em).getTime();
    if (a.status === 'expirado' && a.expiraEm) return new Date(a.expiraEm).getTime();
    return new Date(a.inicio).getTime();
  };
  const doPeriodo = ags.filter((a) => {
    const t = quandoAconteceu(a);
    return t >= desde.toMillis() && t <= agoraMs;
  });
  const desistencias = doPeriodo.filter((a) => a.status === 'cancelado' && a.cancelamento?.por !== 'barbeiro').length;
  const canceladosPeloNegocio = doPeriodo.filter((a) => a.status === 'cancelado' && a.cancelamento?.por === 'barbeiro').length;
  const pixNaoPago = doPeriodo.filter((a) => a.status === 'expirado').length;
  const faltas = doPeriodo.filter((a) => a.status === 'faltou').length;
  const marcados = atendimentos + desistencias + faltas;
  const taxaPerda = marcados ? Math.round(((desistencias + faltas) / marcados) * 100) : 0;
  const motivos = {};
  doPeriodo.filter((a) => a.status === 'cancelado' && a.cancelamento?.por === 'cliente' && a.cancelamento.motivo)
    .forEach((a) => { motivos[a.cancelamento.motivo] = (motivos[a.cancelamento.motivo] || 0) + 1; });

  const clientesPeriodo = new Set(realizadosPeriodo.map(chaveCliente));
  const novos = [...clientesPeriodo].filter((k) => {
    const c = clientePorId.get(k);
    return c && new Date(c.createdAt).getTime() >= desde.toMillis();
  }).length;

  // ---------- Dia da semana e horário (período) ----------
  const porDiaSemana = DIAS.map((dia) => ({ dia, atendimentos: 0, faturamento: 0 }));
  const horas = new Map();
  realizadosPeriodo.forEach((a) => {
    const dt = DateTime.fromJSDate(new Date(a.inicio)).setZone(fuso);
    const d = porDiaSemana[dt.weekday - 1];
    d.atendimentos += 1;
    d.faturamento += centavos(a.valorTotal);
    const h = `${String(dt.hour).padStart(2, '0')}h`;
    horas.set(h, (horas.get(h) || 0) + 1);
  });
  const porHora = [...horas.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([hora, n]) => ({ hora, atendimentos: n }));

  // ---------- Últimos 12 meses ----------
  const meses = Array.from({ length: 12 }, (_, i) => {
    const m = primeiroMes.plus({ months: i });
    return { mes: m.toFormat('yyyy-MM'), rotulo: `${MESES[m.month - 1]}/${m.toFormat('yy')}`, atendimentos: 0, faturamento: 0 };
  });
  const indiceMes = new Map(meses.map((m, i) => [m.mes, i]));
  ags.filter(realizado).forEach((a) => {
    const i = indiceMes.get(DateTime.fromJSDate(new Date(a.inicio)).setZone(fuso).toFormat('yyyy-MM'));
    if (i === undefined) return;
    meses[i].atendimentos += 1;
    meses[i].faturamento += centavos(a.valorTotal);
  });

  // ---------- Serviços que mais rendem (período) ----------
  const porServico = new Map();
  realizadosPeriodo.forEach((a) => {
    itensDoAgendamento(a, precosAtuais).forEach((it) => {
      const atual = porServico.get(it.chave) || { nome: it.nome, quantidade: 0, faturamento: 0 };
      atual.quantidade += 1;
      atual.faturamento += it.valor;
      porServico.set(it.chave, atual);
    });
  });
  const listaServicos = [...porServico.values()].sort((a, b) => b.faturamento - a.faturamento || b.quantidade - a.quantidade);

  // ---------- Clientes ----------
  const porCliente = new Map();
  ags.forEach((a) => {
    const k = chaveCliente(a);
    const c = porCliente.get(k) || {
      nome: a.clienteNome, whatsapp: a.clienteWhatsapp, visitas: 0, faturamento: 0,
      visitasTotal: 0, faturamentoTotal: 0, ultimaVisita: null, datasVisitas: [], temHorarioFuturo: false,
    };
    const t = new Date(a.inicio).getTime();
    if (realizado(a)) {
      c.visitasTotal += 1;
      c.faturamentoTotal += centavos(a.valorTotal);
      c.datasVisitas.push(t);
      if (!c.ultimaVisita || t > c.ultimaVisita) { c.ultimaVisita = t; c.nome = a.clienteNome; }
      if (noPeriodo(a)) { c.visitas += 1; c.faturamento += centavos(a.valorTotal); }
    } else if (['pendente', 'confirmado'].includes(a.status) && t > agoraMs) {
      c.temHorarioFuturo = true;
    }
    porCliente.set(k, c);
  });
  const todos = [...porCliente.values()];
  const formatar = (c) => ({
    nome: c.nome, whatsapp: c.whatsapp, visitas: c.visitas, faturamento: reais(c.faturamento),
    visitasTotal: c.visitasTotal, faturamentoTotal: reais(c.faturamentoTotal),
    ultimaVisita: c.ultimaVisita ? new Date(c.ultimaVisita).toISOString() : null,
    diasSemVir: c.ultimaVisita ? Math.floor((agoraMs - c.ultimaVisita) / DIA_MS) : null,
  });
  const clientesTop = todos.filter((c) => c.visitas > 0)
    .sort((a, b) => b.faturamento - a.faturamento || b.visitas - a.visitas)
    .slice(0, 20).map(formatar);
  const sumidos = todos
    .filter((c) => c.visitasTotal >= 2 && !c.temHorarioFuturo && c.ultimaVisita && agoraMs - c.ultimaVisita > DIAS_SUMIDO * DIA_MS)
    .sort((a, b) => b.faturamentoTotal - a.faturamentoTotal)
    .slice(0, 20).map(formatar);

  // Intervalo típico entre visitas de quem volta (mediana, em dias)
  const intervalos = [];
  todos.forEach((c) => {
    const datas = [...c.datasVisitas].sort((a, b) => a - b);
    for (let i = 1; i < datas.length; i += 1) intervalos.push((datas[i] - datas[i - 1]) / DIA_MS);
  });
  intervalos.sort((a, b) => a - b);
  const mediana = intervalos.length ? intervalos[Math.floor((intervalos.length - 1) / 2)] : null;
  const voltaram = [...clientesPeriodo].filter((k) => (porCliente.get(k)?.visitasTotal || 0) >= 2).length;

  const relatorio = {
    periodo: { dias, desde: desde.toISODate(), ate: agora.toISODate() },
    resumo: {
      faturamento: reais(faturamento),
      recebidoPix: reais(recebidoPix),
      atendimentos,
      ticketMedio: atendimentos ? reais(Math.round(faturamento / atendimentos)) : 0,
      clientes: clientesPeriodo.size,
      clientesNovos: novos,
    },
    perdas: { desistencias, faltas, pixNaoPago, canceladosPeloNegocio, taxaPerda,
      motivos: Object.entries(motivos).sort((a, b) => b[1] - a[1]).map(([motivo, quantidade]) => ({ motivo, quantidade })) },
    retorno: { clientesQueVoltam: voltaram, diasEntreVisitas: mediana === null ? null : Math.max(1, Math.round(mediana)) },
    porDiaSemana: porDiaSemana.map((d) => ({ ...d, faturamento: reais(d.faturamento) })),
    porHora,
    meses: meses.map((m) => ({ ...m, faturamento: reais(m.faturamento) })),
    servicos: listaServicos.map((s) => ({
      nome: s.nome, quantidade: s.quantidade, faturamento: reais(s.faturamento),
      percentual: faturamento ? Math.round((s.faturamento / faturamento) * 100) : 0,
    })),
    clientesTop,
    sumidos,
  };
  relatorio.dicas = gerarDicas(relatorio);
  return relatorio;
}

module.exports = { gerarRelatorio, dividirProporcional, itensDoAgendamento };
