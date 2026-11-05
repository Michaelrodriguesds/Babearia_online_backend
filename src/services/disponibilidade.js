// Calcula horários livres e libera reservas não pagas
const { DateTime } = require('luxon');
const { Agendamento, Slot, Barbearia } = require('../models');
const { MINUTOS_SLOT } = require('../models/Slot');
const { ErroApp } = require('../utils/erros');
const { fuso } = require('../config/env');
const notificar = require('./notificacoes');

function naHora(dia, hhmm) {
  const [hora, minuto] = hhmm.split(':').map(Number);
  return dia.set({ hour: hora, minute: minuto, second: 0, millisecond: 0 });
}

// Fim arredondado para o próximo bloco de 15 min
function fimDosBlocos(inicio, fim) {
  const passo = MINUTOS_SLOT * 60 * 1000;
  const duracao = new Date(fim).getTime() - new Date(inicio).getTime();
  return new Date(new Date(inicio).getTime() + Math.ceil(duracao / passo) * passo);
}

// Lista de inícios de bloco entre dois horários
function blocosEntre(inicio, fim) {
  const passo = MINUTOS_SLOT * 60 * 1000;
  const lista = [];
  for (let t = new Date(inicio).getTime(); t < new Date(fim).getTime(); t += passo) lista.push(new Date(t));
  return lista;
}

/**
 * Reservas "pendente" cujo prazo do Pix venceu viram "expirado"
 * e seus horários voltam a ficar livres. Roda a cada minuto (job) e
 * também antes de calcular horários (assim funciona mesmo se o job atrasar).
 */
async function liberarExpirados(barbeariaId) {
  const filtro = { status: 'pendente', expiraEm: { $lt: new Date() } };
  if (barbeariaId) filtro.barbeariaId = barbeariaId;

  const candidatos = await Agendamento.find(filtro).select('_id').limit(200).lean();
  const liberados = [];
  for (const { _id } of candidatos) {
    // só expira se AINDA estiver pendente (o Pix pode ter sido confirmado agora)
    const r = await Agendamento.updateOne({ _id, status: 'pendente' }, { $set: { status: 'expirado' } });
    if (!r.modifiedCount) continue;
    const ag = await Agendamento.findById(_id).lean();
    await Slot.deleteMany({ agendamentoId: ag._id });
    liberados.push(ag);
  }

  if (liberados.length) {
    const ids = [...new Set(liberados.map((a) => String(a.barbeariaId)))];
    const barbearias = await Barbearia.find({ _id: { $in: ids } }).select('nome slug').lean();
    const porId = new Map(barbearias.map((b) => [String(b._id), b]));
    for (const ag of liberados) {
      const b = porId.get(String(ag.barbeariaId));
      if (b && ag.tipo === 'cliente') notificar.expiradoParaCliente(b, ag);
    }
  }
  return liberados.length;
}

/**
 * Horários livres de um dia para um serviço com X minutos.
 * Faz UMA consulta ao banco (blocos ocupados do dia) e calcula o resto na memória.
 */
async function horariosLivres(barbearia, duracaoMinutos, dataISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataISO || '')) throw new ErroApp(400, 'Data inválida. Use AAAA-MM-DD.');
  const dia = DateTime.fromISO(dataISO, { zone: fuso });
  if (!dia.isValid) throw new ErroApp(400, 'Data inválida.');

  if ((barbearia.folgas || []).includes(dataISO)) return [];
  const expediente = (barbearia.horarios || []).find((h) => h.dia === dia.weekday % 7); // luxon: domingo = 7
  if (!expediente) return [];

  const abre = naHora(dia, expediente.abre);
  const fecha = naHora(dia, expediente.fecha);
  const temPausa = expediente.pausaInicio && expediente.pausaFim;
  const pausaInicio = temPausa ? naHora(dia, expediente.pausaInicio) : null;
  const pausaFim = temPausa ? naHora(dia, expediente.pausaFim) : null;

  const regras = barbearia.regras;
  const agora = DateTime.now().setZone(fuso);
  const minimo = agora.plus({ minutes: regras.antecedenciaMinMinutos });
  const maximo = agora.plus({ days: regras.antecedenciaMaxDias });
  if (fecha <= minimo || abre > maximo) return [];

  await liberarExpirados(barbearia._id);

  const ocupados = await Slot.find({
    barbeariaId: barbearia._id,
    inicio: { $gte: abre.toJSDate(), $lt: fecha.toJSDate() },
  })
    .select('inicio -_id')
    .lean();
  const ocupado = new Set(ocupados.map((s) => new Date(s.inicio).getTime()));

  const blocos = Math.ceil(duracaoMinutos / MINUTOS_SLOT);
  const livres = [];
  for (let t = abre; t.plus({ minutes: blocos * MINUTOS_SLOT }) <= fecha; t = t.plus({ minutes: MINUTOS_SLOT })) {
    if (t < minimo || t > maximo) continue;
    let cabe = true;
    for (let i = 0; i < blocos; i++) {
      const bloco = t.plus({ minutes: i * MINUTOS_SLOT });
      const naPausa = temPausa && bloco >= pausaInicio && bloco < pausaFim;
      if (naPausa || ocupado.has(bloco.toMillis())) { cabe = false; break; }
    }
    if (cabe) livres.push({ hora: t.toFormat('HH:mm'), inicio: t.toISO() });
  }
  return livres;
}

module.exports = { horariosLivres, liberarExpirados, fimDosBlocos, blocosEntre };
