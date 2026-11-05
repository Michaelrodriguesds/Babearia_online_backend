// Cadastro e login do barbeiro (e login do admin)
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { Barbearia, Usuario } = require('../models');
const { gerarToken, exigirLogin } = require('../middlewares/auth');
const { validar } = require('../middlewares/validar');
const { limiteLogin } = require('../middlewares/limites');
const { statusLicenca, DIA_MS } = require('../services/licenca');
const { ErroApp, ehDuplicado } = require('../utils/erros');
const { gerarSlug, normalizarTelefone } = require('../utils/formatos');
const { diasTeste } = require('../config/env');

const router = Router();
const SLUGS_RESERVADOS = ['agendamentos', 'admin', 'api', 'painel', 'login', 'cadastro'];

async function slugDisponivel(nome) {
  const base = gerarSlug(nome) || 'barbearia';
  let slug = SLUGS_RESERVADOS.includes(base) ? `${base}-1` : base;
  for (let n = 2; await Barbearia.exists({ slug }); n++) slug = `${base}-${n}`;
  return slug;
}

const cadastroSchema = z.object({
  nomeBarbearia: z.string().trim().min(2).max(80),
  nome: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(100),
  whatsapp: z.string().regex(/^[\d\s()+-]{10,20}$/, 'WhatsApp inválido'),
});

// Cadastro: já começa com o mês grátis
router.post('/cadastro', limiteLogin, validar(cadastroSchema), async (req, res) => {
  const d = req.validado;
  if (await Usuario.exists({ email: d.email })) throw new ErroApp(409, 'Este e-mail já está cadastrado.');

  const barbearia = await Barbearia.create({
    nome: d.nomeBarbearia,
    slug: await slugDisponivel(d.nomeBarbearia),
    whatsapp: normalizarTelefone(d.whatsapp),
    licenca: { plano: 'teste', acessoAte: new Date(Date.now() + diasTeste * DIA_MS) },
  });

  let usuario;
  try {
    usuario = await Usuario.create({
      nome: d.nome, email: d.email, papel: 'dono', barbeariaId: barbearia._id,
      senhaHash: await bcrypt.hash(d.senha, 10),
    });
  } catch (erro) {
    await Barbearia.deleteOne({ _id: barbearia._id });
    if (ehDuplicado(erro)) throw new ErroApp(409, 'Este e-mail já está cadastrado.');
    throw erro;
  }

  res.status(201).json({
    token: gerarToken(usuario),
    barbearia: { id: barbearia._id, nome: barbearia.nome, slug: barbearia.slug },
    licenca: statusLicenca(barbearia.licenca),
  });
});

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), senha: z.string().min(1) });

router.post('/login', limiteLogin, validar(loginSchema), async (req, res) => {
  const { email, senha } = req.validado;
  const usuario = await Usuario.findOne({ email }).select('+senhaHash');
  if (!usuario || !(await bcrypt.compare(senha, usuario.senhaHash))) throw new ErroApp(401, 'E-mail ou senha incorretos.');

  // O login funciona mesmo com plano vencido: o app mostra a tela "renove seu plano"
  let licenca = null;
  if (usuario.papel === 'dono') {
    const b = await Barbearia.findById(usuario.barbeariaId).select('licenca').lean();
    licenca = b ? statusLicenca(b.licenca) : null;
  }
  res.json({ token: gerarToken(usuario), papel: usuario.papel, nome: usuario.nome, licenca });
});

const trocarSenhaSchema = z.object({ senhaAtual: z.string().min(1), novaSenha: z.string().min(8).max(100) });

router.post('/trocar-senha', exigirLogin, validar(trocarSenhaSchema), async (req, res) => {
  const usuario = await Usuario.findById(req.usuario.id).select('+senhaHash');
  if (!usuario || !(await bcrypt.compare(req.validado.senhaAtual, usuario.senhaHash))) throw new ErroApp(400, 'Senha atual incorreta.');
  usuario.senhaHash = await bcrypt.hash(req.validado.novaSenha, 10);
  await usuario.save();
  res.json({ ok: true });
});

module.exports = router;
