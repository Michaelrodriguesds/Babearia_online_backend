// Bloqueio automático quando o plano vence
const { licencaDaBarbearia, statusLicenca } = require('../services/licenca');
const { suporteWhatsapp } = require('../config/env');

// Painel do barbeiro: responde 402 (pagamento necessário) com instruções
async function exigirLicencaAtiva(req, res, next) {
  const licenca = await licencaDaBarbearia(req.usuario.barbeariaId);
  const status = statusLicenca(licenca);
  req.licenca = status;
  if (!status.ativa) {
    return res.status(402).json({
      erro: 'Seu plano venceu. Fale com o suporte para renovar e voltar a usar o sistema.',
      bloqueado: true,
      licenca: status,
      suporteWhatsapp,
    });
  }
  next();
}

// Página pública: clientes só veem que a agenda está indisponível
async function exigirAgendaAtiva(req, res, next) {
  const status = statusLicenca(await licencaDaBarbearia(req.barbearia._id));
  if (!status.ativa) {
    return res.status(403).json({ erro: 'Agenda temporariamente indisponível. Fale direto com a barbearia.', bloqueado: true });
  }
  next();
}

module.exports = { exigirLicencaAtiva, exigirAgendaAtiva };
