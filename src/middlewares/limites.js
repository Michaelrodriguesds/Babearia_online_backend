// Limite de requisições por IP (protege contra abuso e robôs)
const rateLimit = require('express-rate-limit');

const padrao = { standardHeaders: 'draft-7', legacyHeaders: false };

module.exports = {
  limiteLogin: rateLimit({ ...padrao, windowMs: 15 * 60 * 1000, limit: 20, message: { erro: 'Muitas tentativas. Aguarde 15 minutos.' } }),
  limiteAgendar: rateLimit({ ...padrao, windowMs: 10 * 60 * 1000, limit: 10, message: { erro: 'Muitos agendamentos seguidos. Aguarde alguns minutos.' } }),
  limiteRelato: rateLimit({ ...padrao, windowMs: 10 * 60 * 1000, limit: 5, message: { erro: 'Você já enviou vários relatos. Aguarde alguns minutos.' } }),
  limiteErroAutomatico: rateLimit({ ...padrao, windowMs: 10 * 60 * 1000, limit: 20, message: { erro: 'Limite atingido.' } }),
  limiteGeral: rateLimit({ ...padrao, windowMs: 60 * 1000, limit: 120, message: { erro: 'Muitas requisições. Aguarde um instante.' } }),
};
