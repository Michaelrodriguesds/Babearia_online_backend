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
router.get('/agendamentos/:id', async (req, res) => {
  const ag = await agendamentoComCodigo(req.params.id, req.query.c);
  res.json({
    id: ag._id, status: ag.status, servico: ag.servicoNome, inicio: ag.inicio, fim: ag.fim,
    valorTotal: ag.valorTotal, valorCobrado: ag.valorCobrado, expiraEm: ag.expiraEm,
    clienteNome: ag.clienteNome,
    pix: ag.status === 'pendente' ? { copiaCola: ag.pagamento?.pixCopiaCola || null, modo: ag.pagamento?.modo } : null,
  });
});

router.post('/agendamentos/:id/cancelar', validar(z.object({ codigo: z.string().min(10) })), async (req, res) => {
  const ag = await agendamentoComCodigo(req.params.id, req.validado.codigo);
  const barbearia = await Barbearia.findById(ag.barbeariaId).select('regras').lean();
  const horasAntes = (new Date(ag.inicio).getTime() - Date.now()) / 3600000;
  if (ag.status === 'confirmado' && horasAntes < barbearia.regras.cancelamentoAteHoras) {
    throw new ErroApp(400, `O cancelamento só pode ser feito até ${barbearia.regras.cancelamentoAteHoras}h antes. Fale com a barbearia.`);
  }
  res.json(await agendamentos.cancelarAgendamento(ag, 'cliente'));
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
    nome: b.nome, slug: b.slug, endereco: b.endereco, logoUrl: b.logoUrl, corPrimaria: b.corPrimaria,
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

const dispSchema = z.object({ servicoId: z.string().length(24), data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

// Horários livres: SEM cache, sempre consulta o banco (precisa estar exato)
router.get('/:slug/disponibilidade', carregarBarbearia, exigirAgendaAtiva, validar(dispSchema, 'query'), async (req, res) => {
  const { servicoId, data } = req.validado;
  const servico = await Servico.findOne({ _id: servicoId, barbeariaId: req.barbearia._id, ativo: true }).select('duracaoMinutos').lean();
  if (!servico) throw new ErroApp(404, 'Serviço não encontrado.');
  res.json({ data, horarios: await horariosLivres(req.barbearia, servico.duracaoMinutos, data) });
});

const agendarSchema = z.object({
  servicoId: z.string().length(24),
  inicio: z.string().min(16), // ISO, ex.: 2026-10-25T14:00:00.000-03:00 (use o "inicio" da disponibilidade)
  nome: z.string().trim().min(2).max(80),
  whatsapp: z.string().regex(/^[\d\s()+-]{10,20}$/, 'WhatsApp inválido'),
  email: z.string().trim().email().optional(),
});

router.post('/:slug/agendamentos', limiteAgendar, carregarBarbearia, exigirAgendaAtiva, validar(agendarSchema), async (req, res) => {
  const resultado = await agendamentos.criarAgendamento(req.barbearia, req.validado);
  res.status(201).json({
    ...resultado,
    inicioFormatado: DateTime.fromJSDate(resultado.inicio).setZone(fuso).setLocale('pt-BR').toFormat("cccc, dd 'de' LLLL 'às' HH:mm"),
  });
});

module.exports = router;
