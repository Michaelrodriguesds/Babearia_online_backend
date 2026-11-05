// Painel do barbeiro (precisa de login + plano ativo)
const { Router } = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const { DateTime } = require('luxon');
const { Barbearia, Servico, Agendamento, Cliente, PushInscricao, Relato } = require('../models');
const { enviarPush } = require('../services/push');
const { exigirLogin, exigirDono } = require('../middlewares/auth');
const { exigirLicencaAtiva } = require('../middlewares/licenca');
const { validar } = require('../middlewares/validar');
const { licencaDaBarbearia, statusLicenca } = require('../services/licenca');
const agendamentos = require('../services/agendamentos');
const { criptografar } = require('../utils/cripto');
const { invalidar } = require('../utils/cache');
const { ErroApp } = require('../utils/erros');
const { normalizarTelefone } = require('../utils/formatos');
const { fuso, frontendUrls, suporteWhatsapp, vapid } = require('../config/env');

const router = Router();
router.use(exigirLogin, exigirDono);

// Status do plano: funciona MESMO VENCIDO (para o app mostrar a tela de renovação)
router.get('/licenca', async (req, res) => {
  const b = await Barbearia.findById(req.usuario.barbeariaId).select('nome').lean();
  res.json({
    ...statusLicenca(await licencaDaBarbearia(req.usuario.barbeariaId)),
    barbeariaId: req.usuario.barbeariaId,
    barbeariaNome: b?.nome || '',
    suporteWhatsapp,
  });
});

// Daqui para baixo, tudo exige plano ativo
router.use(exigirLicencaAtiva);

const bid = (req) => req.usuario.barbeariaId;

async function invalidarPublico(barbeariaId) {
  const b = await Barbearia.findById(barbeariaId).select('slug').lean();
  if (b) invalidar(`publico:${b.slug}`);
}

// ---------- Dados da barbearia ----------
router.get('/me', async (req, res) => {
  const barbearia = await Barbearia.findById(bid(req)).lean();
  if (!barbearia) throw new ErroApp(404, 'Barbearia não encontrada.');
  res.json({ barbearia, licenca: req.licenca, linkPublico: `${frontendUrls[0]}/b/${barbearia.slug}` });
});

const HORA15 = /^([01]\d|2[0-3]):(00|15|30|45)$/; // de 15 em 15 minutos
const horarioSchema = z
  .object({
    dia: z.number().int().min(0).max(6),
    abre: z.string().regex(HORA15, 'Use HH:mm em múltiplos de 15 min'),
    fecha: z.string().regex(HORA15, 'Use HH:mm em múltiplos de 15 min'),
    pausaInicio: z.string().regex(HORA15).optional(),
    pausaFim: z.string().regex(HORA15).optional(),
  })
  .refine((h) => h.abre < h.fecha, 'O horário de abrir deve ser antes do de fechar');

const barbeariaSchema = z.object({
  nome: z.string().trim().min(2).max(80).optional(),
  whatsapp: z.string().regex(/^[\d\s()+-]{10,20}$/).optional(),
  endereco: z.string().max(200).optional(),
  logoUrl: z.string().url().or(z.literal('')).optional(),
  corPrimaria: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  horarios: z.array(horarioSchema).max(7).optional(),
  folgas: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(200).optional(),
  regras: z
    .object({
      antecedenciaMinMinutos: z.number().int().min(0).max(10080),
      antecedenciaMaxDias: z.number().int().min(1).max(180),
      minutosParaPagar: z.number().int().min(5).max(1440),
      cobranca: z.enum(['integral', 'sinal', 'local']),
      sinalTipo: z.enum(['percentual', 'fixo']),
      sinalValor: z.number().min(0).max(10000),
      cancelamentoAteHoras: z.number().min(0).max(168),
      lembrete24h: z.boolean(),
      lembrete2h: z.boolean(),
    })
    .partial()
    .optional(),
});

router.put('/barbearia', validar(barbeariaSchema), async (req, res) => {
  const { regras, whatsapp, ...resto } = req.validado;
  const $set = { ...resto };
  if (whatsapp) $set.whatsapp = normalizarTelefone(whatsapp);
  for (const [chave, valor] of Object.entries(regras || {})) $set[`regras.${chave}`] = valor;

  await Barbearia.updateOne({ _id: bid(req) }, { $set }, { runValidators: true });
  const barbearia = await Barbearia.findById(bid(req)).lean();
  invalidar(`publico:${barbearia.slug}`);
  res.json({ barbearia });
});

// ---------- Forma de receber o Pix ----------
const pagamentoSchema = z.object({
  modo: z.enum(['manual', 'mercadopago']),
  chavePix: z.string().trim().max(77).optional(),
  nomeRecebedor: z.string().trim().max(25).optional(),
  cidade: z.string().trim().max(15).optional(),
  mercadoPagoAccessToken: z.string().trim().min(20).optional(),
});

router.put('/pagamento', validar(pagamentoSchema), async (req, res) => {
  const d = req.validado;
  // "+campo" sozinho = traz tudo e também o token (pedir "pagamento" junto dá erro no MongoDB Atlas)
  const atual = await Barbearia.findById(bid(req)).select('+pagamento.mpAccessTokenCripto').lean();

  if (d.modo === 'manual' && !(d.chavePix || atual.pagamento?.chavePix)) throw new ErroApp(400, 'Informe a chave Pix.');
  if (d.modo === 'mercadopago' && !(d.mercadoPagoAccessToken || atual.pagamento?.mpAccessTokenCripto)) {
    throw new ErroApp(400, 'Informe o Access Token do Mercado Pago.');
  }

  const $set = { 'pagamento.modo': d.modo };
  for (const campo of ['chavePix', 'nomeRecebedor', 'cidade']) if (d[campo] !== undefined) $set[`pagamento.${campo}`] = d[campo];
  if (d.mercadoPagoAccessToken) $set['pagamento.mpAccessTokenCripto'] = criptografar(d.mercadoPagoAccessToken);

  await Barbearia.updateOne({ _id: bid(req) }, { $set });
  const b = await Barbearia.findById(bid(req)).lean();
  invalidar(`publico:${atual.slug}`);
  // o token nunca volta na resposta
  res.json({ pagamento: { modo: b.pagamento.modo, chavePix: b.pagamento.chavePix, nomeRecebedor: b.pagamento.nomeRecebedor, cidade: b.pagamento.cidade, mercadoPagoConfigurado: Boolean(d.mercadoPagoAccessToken || atual.pagamento?.mpAccessTokenCripto) } });
});

// ---------- Serviços ----------
const servicoSchema = z.object({
  nome: z.string().trim().min(2).max(60),
  descricao: z.string().max(200).optional(),
  preco: z.number().min(0).max(10000),
  duracaoMinutos: z.number().int().min(15).max(480),
  ativo: z.boolean().optional(),
  ordem: z.number().int().optional(),
});

router.get('/servicos', async (req, res) => {
  res.json(await Servico.find({ barbeariaId: bid(req) }).sort({ ordem: 1, nome: 1 }).lean());
});

router.post('/servicos', validar(servicoSchema), async (req, res) => {
  const servico = await Servico.create({ ...req.validado, barbeariaId: bid(req) });
  await invalidarPublico(bid(req));
  res.status(201).json(servico);
});

router.put('/servicos/:id', validar(servicoSchema.partial()), async (req, res) => {
  const servico = await Servico.findOneAndUpdate({ _id: req.params.id, barbeariaId: bid(req) }, { $set: req.validado }, { new: true, runValidators: true }).lean();
  if (!servico) throw new ErroApp(404, 'Serviço não encontrado.');
  await invalidarPublico(bid(req));
  res.json(servico);
});

// Não apaga de verdade (o histórico de agendamentos continua certo)
router.delete('/servicos/:id', async (req, res) => {
  const r = await Servico.updateOne({ _id: req.params.id, barbeariaId: bid(req) }, { $set: { ativo: false } });
  if (!r.matchedCount) throw new ErroApp(404, 'Serviço não encontrado.');
  await invalidarPublico(bid(req));
  res.json({ ok: true });
});

// ---------- Agenda ----------
const listaSchema = z.object({
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['pendente', 'confirmado', 'cancelado', 'expirado', 'concluido', 'bloqueado', 'conflito']).optional(),
  pagina: z.coerce.number().int().min(1).default(1),
  limite: z.coerce.number().int().min(1).max(50).default(20),
});

// Lista paginada (melhoria do Glamour: nunca carrega tudo de uma vez)
router.get('/agendamentos', validar(listaSchema, 'query'), async (req, res) => {
  const { data, de, ate, status, pagina, limite } = req.validado;
  const dia = (iso) => DateTime.fromISO(iso, { zone: fuso });
  let inicio, fim;
  if (data) { inicio = dia(data); fim = inicio.plus({ days: 1 }); }
  else {
    inicio = de ? dia(de) : DateTime.now().setZone(fuso).startOf('day');
    fim = ate ? dia(ate).plus({ days: 1 }) : inicio.plus({ days: 60 });
  }

  const filtro = { barbeariaId: bid(req), inicio: { $gte: inicio.toJSDate(), $lt: fim.toJSDate() } };
  if (status) filtro.status = status;

  const [itens, total] = await Promise.all([
    Agendamento.find(filtro)
      .select('tipo servicoNome clienteNome clienteWhatsapp motivo inicio fim valorTotal valorCobrado status expiraEm pagamento.modo pagamento.pagoEm')
      .sort({ inicio: 1 })
      .skip((pagina - 1) * limite)
      .limit(limite)
      .lean(),
    Agendamento.countDocuments(filtro),
  ]);
  res.json({ itens, total, pagina, paginas: Math.ceil(total / limite) });
});

async function agendamentoDoBarbeiro(req) {
  const ag = await Agendamento.findOne({ _id: req.params.id, barbeariaId: bid(req), tipo: 'cliente' });
  if (!ag) throw new ErroApp(404, 'Agendamento não encontrado.');
  return ag;
}

// Modo Pix manual: o barbeiro viu o Pix na conta e confirma com 1 toque
router.post('/agendamentos/:id/confirmar', async (req, res) => {
  const ag = await agendamentoDoBarbeiro(req);
  const confirmado = await agendamentos.confirmarPagamento(ag._id, { por: 'barbeiro' });
  res.json({ id: confirmado._id, status: confirmado.status });
});

router.post('/agendamentos/:id/cancelar', async (req, res) => {
  res.json(await agendamentos.cancelarAgendamento(await agendamentoDoBarbeiro(req), 'barbeiro'));
});

// ---------- Bloqueios de agenda ----------
const bloqueioSchema = z.object({ inicio: z.string().min(10), fim: z.string().min(10), motivo: z.string().max(100).optional() });

router.post('/bloqueios', validar(bloqueioSchema), async (req, res) => {
  const ag = await agendamentos.criarBloqueio(bid(req), req.validado);
  res.status(201).json({ id: ag._id, inicio: ag.inicio, fim: ag.fim, motivo: ag.motivo });
});

router.delete('/bloqueios/:id', async (req, res) => {
  await agendamentos.removerBloqueio(bid(req), req.params.id);
  res.json({ ok: true });
});

// ---------- Resumo (consultas pequenas em paralelo, todas usando índice) ----------
router.get('/resumo', async (req, res) => {
  const agora = DateTime.now().setZone(fuso);
  const hoje = agora.startOf('day');
  const id = new mongoose.Types.ObjectId(bid(req));
  const doMes = { barbeariaId: id, tipo: 'cliente', inicio: { $gte: agora.startOf('month').toJSDate(), $lt: agora.endOf('month').toJSDate() } };
  const realizados = { ...doMes, status: { $in: ['confirmado', 'concluido'] } };

  const [hojeQtd, aguardandoPix, conflitos, proximos, [mes], [pix]] = await Promise.all([
    Agendamento.countDocuments({ barbeariaId: id, tipo: 'cliente', status: { $in: ['confirmado', 'concluido'] }, inicio: { $gte: hoje.toJSDate(), $lt: hoje.plus({ days: 1 }).toJSDate() } }),
    Agendamento.countDocuments({ barbeariaId: id, status: 'pendente' }),
    Agendamento.countDocuments({ barbeariaId: id, status: 'conflito' }),
    Agendamento.find({ barbeariaId: id, status: 'confirmado', inicio: { $gte: agora.toJSDate() } }).select('clienteNome servicoNome inicio').sort({ inicio: 1 }).limit(5).lean(),
    Agendamento.aggregate([{ $match: realizados }, { $group: { _id: null, atendimentos: { $sum: 1 }, faturamento: { $sum: '$valorTotal' } } }]),
    Agendamento.aggregate([{ $match: { ...realizados, 'pagamento.pagoEm': { $ne: null } } }, { $group: { _id: null, total: { $sum: '$valorCobrado' } } }]),
  ]);

  res.json({
    hoje: hojeQtd,
    aguardandoPix,
    conflitos,
    proximos,
    mes: { atendimentos: mes?.atendimentos || 0, faturamento: mes?.faturamento || 0, recebidoPix: pix?.total || 0 },
    licenca: req.licenca,
  });
});

// ---------- Notificações push (grátis) ----------
router.get('/push/chave', (_req, res) => res.json({ chave: vapid.publica || null }));

const pushSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

router.post('/push/inscrever', validar(pushSchema), async (req, res) => {
  const { endpoint, keys } = req.validado;
  await PushInscricao.updateOne(
    { endpoint },
    { $set: { keys, barbeariaId: bid(req), admin: false, usuarioId: req.usuario.id } },
    { upsert: true }
  );
  enviarPush(bid(req), { titulo: 'Notificações ativadas ✅', corpo: 'Você vai receber aqui os avisos de agendamento.' });
  res.json({ ok: true });
});

router.post('/push/cancelar', validar(z.object({ endpoint: z.string().url() })), async (req, res) => {
  await PushInscricao.deleteOne({ endpoint: req.validado.endpoint, barbeariaId: bid(req) });
  res.json({ ok: true });
});

// ---------- Relatos que o barbeiro enviou (e suas respostas) ----------
router.get('/relatos', async (req, res) => {
  const itens = await Relato.find({ barbeariaId: bid(req), origem: 'barbeiro' })
    .select('tipo mensagem status resposta createdAt')
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  res.json(itens);
});

// ---------- Clientes ----------
const clientesSchema = z.object({
  busca: z.string().max(60).optional(),
  pagina: z.coerce.number().int().min(1).default(1),
  limite: z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/clientes', validar(clientesSchema, 'query'), async (req, res) => {
  const { busca, pagina, limite } = req.validado;
  const filtro = { barbeariaId: bid(req) };
  if (busca) {
    const seguro = busca.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filtro.$or = [{ nome: { $regex: seguro, $options: 'i' } }, { whatsapp: { $regex: seguro.replace(/\D/g, '') || seguro } }];
  }
  const [itens, total] = await Promise.all([
    Cliente.find(filtro).sort({ nome: 1 }).skip((pagina - 1) * limite).limit(limite).lean(),
    Cliente.countDocuments(filtro),
  ]);
  res.json({ itens, total, pagina, paginas: Math.ceil(total / limite) });
});

module.exports = router;
