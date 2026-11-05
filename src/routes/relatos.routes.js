// Clientes e barbeiros relatam problemas e sugestões; o app também envia
// sozinho os erros que acontecem no celular das pessoas.
const crypto = require('crypto');
const { Router } = require('express');
const { z } = require('zod');
const { Barbearia, Relato } = require('../models');
const { lerLoginOpcional } = require('../middlewares/auth');
const { validar } = require('../middlewares/validar');
const { limiteRelato, limiteErroAutomatico } = require('../middlewares/limites');
const { enviarPushAdmin } = require('../services/push');

const router = Router();

const TIPOS = { problema: 'Problema', sugestao: 'Sugestão', outro: 'Mensagem' };

const relatoSchema = z.object({
  tipo: z.enum(['problema', 'sugestao', 'outro']),
  mensagem: z.string().trim().min(5, 'Conte um pouco mais (mínimo 5 letras).').max(2000),
  contato: z.string().trim().max(120).optional(),
  pagina: z.string().max(300).optional(),
  slug: z.string().max(60).optional(), // página da barbearia onde o cliente estava
});

router.post('/', limiteRelato, lerLoginOpcional, validar(relatoSchema), async (req, res) => {
  const d = req.validado;
  const ehBarbeiro = req.usuario?.papel === 'dono';

  let barbearia = null;
  if (ehBarbeiro) barbearia = await Barbearia.findById(req.usuario.barbeariaId).select('nome').lean();
  else if (d.slug) barbearia = await Barbearia.findOne({ slug: d.slug.toLowerCase() }).select('nome').lean();

  const relato = await Relato.create({
    origem: ehBarbeiro ? 'barbeiro' : 'cliente',
    tipo: d.tipo,
    mensagem: d.mensagem,
    contato: d.contato || '',
    barbeariaId: barbearia?._id || null,
    barbeariaNome: barbearia?.nome || '',
    usuarioId: ehBarbeiro ? req.usuario.id : null,
    pagina: d.pagina || '',
    navegador: String(req.headers['user-agent'] || '').slice(0, 300),
  });

  enviarPushAdmin({
    titulo: `${TIPOS[d.tipo]} de ${ehBarbeiro ? 'barbeiro' : 'cliente'}${barbearia ? ` • ${barbearia.nome}` : ''}`,
    corpo: d.mensagem.slice(0, 140),
    url: '/admin?aba=relatos',
  });
  res.status(201).json({ ok: true, id: relato._id });
});

// Erros capturados automaticamente pelo app. Erros iguais viram um relato só.
const erroSchema = z.object({
  mensagem: z.string().trim().min(1).max(500),
  pilha: z.string().max(4000).optional(),
  pagina: z.string().max(300).optional(),
});

router.post('/automatico', limiteErroAutomatico, lerLoginOpcional, validar(erroSchema), async (req, res) => {
  const d = req.validado;
  const primeiraLinha = (d.pilha || '').split('\n').slice(0, 2).join(' ');
  const assinatura = crypto.createHash('sha1').update(`${d.mensagem}|${primeiraLinha}`).digest('hex');

  const existente = await Relato.findOne({ assinatura }).select('_id status').lean();
  if (existente) {
    // se você marcou como resolvido e voltou a acontecer, reabre
    const reabrir = existente.status === 'resolvido' ? { status: 'novo' } : {};
    await Relato.updateOne({ _id: existente._id }, { $inc: { ocorrencias: 1 }, $set: { ultimaVez: new Date(), ...reabrir } });
    if (reabrir.status) enviarPushAdmin({ titulo: 'Erro voltou a acontecer', corpo: d.mensagem.slice(0, 140), url: '/admin?aba=relatos' });
    return res.json({ ok: true });
  }

  await Relato.create({
    origem: 'automatico',
    tipo: 'erro_automatico',
    mensagem: d.mensagem,
    pilha: d.pilha || '',
    pagina: d.pagina || '',
    navegador: String(req.headers['user-agent'] || '').slice(0, 300),
    barbeariaId: req.usuario?.barbeariaId || null,
    assinatura,
  });
  enviarPushAdmin({ titulo: 'Novo erro no app', corpo: d.mensagem.slice(0, 140), url: '/admin?aba=relatos' });
  res.status(201).json({ ok: true });
});

module.exports = router;
