// Página pública da barbearia (o cliente agenda sem precisar de conta)
const { Router } = require('express');
const { z } = require('zod');
const { DateTime } = require('luxon');
const { Barbearia, Servico, Agendamento } = require('../models');
const { exigirAgendaAtiva } = require('../middlewares/licenca');
const { validar } = require('../middlewares/validar');
const { limiteAgendar } = require('../middlewares/limites');
const { horariosLivres } = require('../services/disponibilidade');
const agendamentos = require('../services/agendamentos');
const { comCacheSWR } = require('../utils/cache');
const { ErroApp } = require('../utils/erros');
const { fuso } = require('../config/env');

const router = Router();

// ---------- Rotas por código (vêm antes das rotas com :slug) ----------
async function agendamentoComCodigo(id, codigo) {
  const ag = await Agendamento.findOne({ _id: id, tipo: 'cliente' }).select('+codigoCancelamento');
  if (!ag || !codigo || ag.codigoCancelamento !== codigo) throw new ErroApp(404, 'Agendamento não encontrado.');
  return ag;
}

// A tela do Pix consulta aqui a cada poucos segundos para saber se já foi pago
// Regra de desistência: aguardando Pix pode sempre; confirmado só até X horas antes
function regraDesistencia(ag, regras) {
  const prazoHoras = Number(regras?.cancelamentoAteHoras) || 0;
  const horasAntes = (new Date(ag.inicio).getTime() - Date.now()) / 3600000;
  let podeDesistir = false;
  if (ag.status === 'pendente') podeDesistir = true;
  else if (ag.status === 'confirmado') podeDesistir = horasAntes >= prazoHoras;
  return { prazoHoras, podeDesistir };
}
const textoNegocio = (b) => ({ salao: 'o salão', outro: 'o estabelecimento' }[b?.tipo] || 'a barbearia');

router.get('/agendamentos/:id', async (req, res) => {
  const ag = await agendamentoComCodigo(req.params.id, req.query.c);
  const barbearia = await Barbearia.findById(ag.barbeariaId).select('regras tipo').lean();
  const desistencia = regraDesistencia(ag, barbearia?.regras);
  res.json({
    desistencia,
    id: ag._id, status: ag.status, servico: ag.servicoNome, inicio: ag.inicio, fim: ag.fim,
    valorTotal: ag.valorTotal, valorCobrado: ag.valorCobrado, expiraEm: ag.expiraEm,
    clienteNome: ag.clienteNome,
    pagamentoInformado: Boolean(ag.pagamento?.informadoEm),
    pix: ag.status === 'pendente' ? { copiaCola: ag.pagamento?.pixCopiaCola || null, modo: ag.pagamento?.modo } : null,
  });
});

// Cliente avisa que já fez o Pix (para o contador e avisa o barbeiro)
router.post('/agendamentos/:id/informar-pagamento', validar(z.object({ codigo: z.string().min(10) })), async (req, res) => {
  const ag = await agendamentoComCodigo(req.params.id, req.validado.codigo);
  const atualizado = await agendamentos.informarPagamento(ag);
  res.json({ status: atualizado.status, pagamentoInformado: true, expiraEm: atualizado.expiraEm });
});

const cancelarSchema = z.object({ codigo: z.string().min(10), motivo: z.string().trim().max(200).optional() });
router.post('/agendamentos/:id/cancelar', validar(cancelarSchema), async (req, res) => {
  const ag = await agendamentoComCodigo(req.params.id, req.validado.codigo);
  const barbearia = await Barbearia.findById(ag.barbeariaId).select('regras tipo').lean();
  const { prazoHoras, podeDesistir } = regraDesistencia(ag, barbearia?.regras);
  if (ag.status === 'confirmado' && !podeDesistir) {
    throw new ErroApp(400, `Pelo app, só dá para desistir até ${prazoHoras}h antes do horário. Fale com ${textoNegocio(barbearia)} pelo WhatsApp.`);
  }
  res.json(await agendamentos.cancelarAgendamento(ag, 'cliente', req.validado.motivo));
});

// ---------- Rotas da barbearia ----------
// Carrega a barbearia pelo link (cache SWR: dados que mudam pouco)
async function carregarBarbearia(req, _res, next) {
  const slug = String(req.params.slug || '').toLowerCase();
  const barbearia = await comCacheSWR(`publico:${slug}`, 60 * 1000, () =>
    Barbearia.findOne({ slug }).select('-pagamento.mpAccessTokenCripto').lean()
  );
  if (!barbearia) throw new ErroApp(404, 'Barbearia não encontrada.');
  req.barbearia = barbearia;
  next();
}

router.get('/:slug', carregarBarbearia, exigirAgendaAtiva, async (req, res) => {
  const b = req.barbearia;
  const servicos = await comCacheSWR(`publico:${b.slug}:servicos`, 60 * 1000, () =>
    Servico.find({ barbeariaId: b._id, ativo: true }).select('nome descricao preco duracaoMinutos').sort({ ordem: 1, nome: 1 }).lean()
  );
  res.json({
    nome: b.nome, slug: b.slug, tipo: b.tipo || 'barbearia', tipoNome: b.tipoNome || '', icone: b.icone || '', endereco: b.endereco, logoUrl: b.logoUrl, corPrimaria: b.corPrimaria,
    whatsapp: b.whatsapp, pagamentoModo: b.pagamento?.modo || 'manual',
    horarios: b.horarios, folgas: b.folgas,
    regras: {
      cobranca: b.regras.cobranca, sinalTipo: b.regras.sinalTipo, sinalValor: b.regras.sinalValor,
      antecedenciaMaxDias: b.regras.antecedenciaMaxDias, minutosParaPagar: b.regras.minutosParaPagar,
      cancelamentoAteHoras: b.regras.cancelamentoAteHoras,
    },
    servicos: servicos.map((s) => ({ ...s, valorPix: agendamentos.calcularCobranca(b.regras, s.preco) })),
  });
});

const ID = /^[0-9a-f]{24}$/i;
// Aceita "servicoIds=id1,id2" (vários) ou o antigo "servicoId=id" (um só)
const listaDeIds = z.string().transform((t) => t.split(',').map((x) => x.trim()).filter(Boolean))
  .refine((l) => l.length >= 1 && l.length <= 10 && l.every((x) => ID.test(x)), 'Serviços inválidos');
const dispSchema = z.object({
  servicoIds: listaDeIds.optional(),
  servicoId: z.string().regex(ID).optional(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine((q) => q.servicoIds || q.servicoId, 'Escolha pelo menos um serviço');

// Horários livres: SEM cache, sempre consulta o banco (precisa estar exato).
// Usa o tempo de TODOS os serviços escolhidos somados.
router.get('/:slug/disponibilidade', carregarBarbearia, exigirAgendaAtiva, validar(dispSchema, 'query'), async (req, res) => {
  const { servicoIds, servicoId, data } = req.validado;
  const escolha = await agendamentos.carregarServicos(req.barbearia._id, servicoIds || [servicoId]);
  res.json({
    data,
    duracaoMinutos: escolha.duracaoMinutos,
    precoTotal: escolha.preco,
    valorPix: agendamentos.calcularCobranca(req.barbearia.regras, escolha.preco),
    horarios: await horariosLivres(req.barbearia, escolha.duracaoMinutos, data),
  });
});

const agendarSchema = z.object({
  servicoIds: z.array(z.string().regex(ID)).min(1).max(10).optional(),
  servicoId: z.string().regex(ID).optional(), // versão antiga do app (um serviço)
  inicio: z.string().min(16), // ISO, ex.: 2026-10-25T14:00:00.000-03:00 (use o "inicio" da disponibilidade)
  nome: z.string().trim().min(2).max(80),
  whatsapp: z.string().regex(/^[\d\s()+-]{10,20}$/, 'WhatsApp inválido'),
  email: z.string().trim().email().optional(),
}).refine((d) => d.servicoIds || d.servicoId, { message: 'Escolha pelo menos um serviço', path: ['servicoIds'] });

router.post('/:slug/agendamentos', limiteAgendar, carregarBarbearia, exigirAgendaAtiva, validar(agendarSchema), async (req, res) => {
  const { servicoId, servicoIds, ...resto } = req.validado;
  const resultado = await agendamentos.criarAgendamento(req.barbearia, { ...resto, servicoIds: servicoIds || [servicoId] });
  res.status(201).json({
    ...resultado,
    inicioFormatado: DateTime.fromJSDate(resultado.inicio).setZone(fuso).setLocale('pt-BR').toFormat("cccc, dd 'de' LLLL 'às' HH:mm"),
  });
});

module.exports = router;
