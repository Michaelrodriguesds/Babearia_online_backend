// Painel do DESENVOLVEDOR (você): ver barbearias, renovar e bloquear planos
const { Router } = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { Barbearia, Usuario, Relato, PushInscricao } = require('../models');
const { exigirLogin, exigirAdmin } = require('../middlewares/auth');
const { validar } = require('../middlewares/validar');
const { statusLicenca, renovar, bloquearAgora } = require('../services/licenca');
const { ErroApp } = require('../utils/erros');
const { diasPlano, vapid } = require('../config/env');
const { lerAvisoCompleto, salvarAviso, avisoPublico } = require('../services/sistema');
const { enviarPush, enviarPushAdmin } = require('../services/push');

const router = Router();
router.use(exigirLogin, exigirAdmin);

// Barbearias + e-mail do dono (duas consultas simples)
async function listarComDono(filtro = {}) {
  const barbearias = await Barbearia.find(filtro).select('nome slug whatsapp licenca createdAt').sort({ 'licenca.acessoAte': 1 }).lean();
  const donos = await Usuario.find({ papel: 'dono', barbeariaId: { $in: barbearias.map((b) => b._id) } }).select('nome email barbeariaId').lean();
  const porBarbearia = new Map(donos.map((d) => [String(d.barbeariaId), { nome: d.nome, email: d.email }]));
  return barbearias.map((b) => ({ ...b, dono: porBarbearia.get(String(b._id)) || null }));
}

// Lista todas, das que vencem primeiro para as últimas
router.get('/barbearias', async (req, res) => {
  const situacao = req.query.situacao; // teste | ativo | vencendo | vencido
  const lista = (await listarComDono()).map((b) => ({ ...b, licenca: statusLicenca(b.licenca), observacao: b.licenca.observacao }));
  res.json(situacao ? lista.filter((b) => b.licenca.situacao === situacao) : lista);
});

router.get('/resumo', async (_req, res) => {
  const lista = await Barbearia.find().select('licenca').lean();
  const contagem = { total: lista.length, teste: 0, ativo: 0, vencendo: 0, vencido: 0 };
  for (const b of lista) contagem[statusLicenca(b.licenca).situacao]++;
  contagem.relatosNovos = await Relato.countDocuments({ status: 'novo' });
  res.json(contagem);
});

router.get('/barbearias/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ErroApp(400, 'Identificador inválido.');
  const [b] = await listarComDono({ _id: new mongoose.Types.ObjectId(req.params.id) });
  if (!b) throw new ErroApp(404, 'Barbearia não encontrada.');
  res.json({ ...b, licenca: statusLicenca(b.licenca), observacao: b.licenca.observacao });
});

// Você recebeu o pagamento do mês → renova (+30 dias por padrão)
const renovarSchema = z.object({ dias: z.number().int().min(1).max(366).default(diasPlano), observacao: z.string().max(200).optional() });

router.post('/barbearias/:id/renovar', validar(renovarSchema), async (req, res) => {
  res.json(await renovar(req.params.id, req.validado.dias, req.validado.observacao));
});

// Bloqueia na hora (ex.: pagamento estornado)
router.post('/barbearias/:id/bloquear', async (req, res) => {
  await bloquearAgora(req.params.id);
  res.json({ ok: true });
});

// Barbeiro esqueceu a senha: você define uma nova e passa para ele
router.post('/barbearias/:id/resetar-senha', validar(z.object({ novaSenha: z.string().min(8).max(100) })), async (req, res) => {
  const r = await Usuario.updateOne(
    { barbeariaId: req.params.id, papel: 'dono' },
    { $set: { senhaHash: await bcrypt.hash(req.validado.novaSenha, 10) } }
  );
  if (!r.matchedCount) throw new ErroApp(404, 'Usuário da barbearia não encontrado.');
  res.json({ ok: true });
});

// ---------- Relatos (bugs, erros e sugestões) ----------
const listaRelatosSchema = z.object({
  status: z.enum(['novo', 'analisando', 'resolvido', 'descartado']).optional(),
  origem: z.enum(['cliente', 'barbeiro', 'automatico']).optional(),
  pagina: z.coerce.number().int().min(1).default(1),
});

router.get('/relatos', validar(listaRelatosSchema, 'query'), async (req, res) => {
  const { status, origem, pagina } = req.validado;
  const filtro = {};
  if (status) filtro.status = status;
  if (origem) filtro.origem = origem;
  const limite = 20;
  const [itens, total] = await Promise.all([
    Relato.find(filtro).sort({ ultimaVez: -1 }).skip((pagina - 1) * limite).limit(limite).lean(),
    Relato.countDocuments(filtro),
  ]);
  res.json({ itens, total, pagina, paginas: Math.ceil(total / limite) });
});

const atualizarRelatoSchema = z.object({
  status: z.enum(['novo', 'analisando', 'resolvido', 'descartado']).optional(),
  resposta: z.string().trim().max(1000).optional(),
});

router.patch('/relatos/:id', validar(atualizarRelatoSchema), async (req, res) => {
  const relato = await Relato.findById(req.params.id);
  if (!relato) throw new ErroApp(404, 'Relato não encontrado.');
  const respostaNova = req.validado.resposta !== undefined && req.validado.resposta !== relato.resposta;
  Object.assign(relato, req.validado);
  await relato.save();
  // o barbeiro recebe um aviso quando você responde
  if (respostaNova && relato.resposta && relato.origem === 'barbeiro' && relato.barbeariaId) {
    enviarPush(relato.barbeariaId, { titulo: 'Resposta do suporte', corpo: relato.resposta.slice(0, 140), url: '/painel/ajustes#ajuda' });
  }
  res.json(relato);
});

// ---------- Aviso geral e manutenção ----------
router.get('/aviso', async (_req, res) => {
  res.json({ aviso: await lerAvisoCompleto(), situacao: await avisoPublico() });
});

const avisoSchema = z
  .object({
    ativo: z.boolean(),
    tipo: z.enum(['informativo', 'manutencao']),
    mensagem: z.string().trim().max(500),
    inicio: z.string().datetime({ offset: true }).nullable().optional(),
    fim: z.string().datetime({ offset: true }).nullable().optional(),
    bloquear: z.boolean().default(false),
    mostrarPara: z.enum(['todos', 'barbeiros']).default('todos'),
  })
  .refine((a) => !a.ativo || a.mensagem.length >= 5, { message: 'Escreva a mensagem do aviso.', path: ['mensagem'] })
  .refine((a) => !a.inicio || !a.fim || new Date(a.fim) > new Date(a.inicio), { message: 'O fim precisa ser depois do início.', path: ['fim'] });

router.put('/aviso', validar(avisoSchema), async (req, res) => {
  const a = req.validado;
  await salvarAviso({
    ...a,
    inicio: a.inicio ? new Date(a.inicio) : null,
    fim: a.fim ? new Date(a.fim) : null,
    bloquear: a.tipo === 'manutencao' ? a.bloquear : false,
  });
  res.json({ aviso: await lerAvisoCompleto(), situacao: await avisoPublico() });
});

// ---------- Notificações no SEU celular ----------
router.get('/push/chave', (_req, res) => res.json({ chave: vapid.publica || null }));

const pushSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

router.post('/push/inscrever', validar(pushSchema), async (req, res) => {
  const { endpoint, keys } = req.validado;
  await PushInscricao.updateOne(
    { endpoint },
    { $set: { keys, admin: true, barbeariaId: null, usuarioId: req.usuario.id } },
    { upsert: true }
  );
  enviarPushAdmin({ titulo: 'Notificações ativadas ✅', corpo: 'Você vai receber aqui os novos relatos e erros.' });
  res.json({ ok: true });
});

module.exports = router;
