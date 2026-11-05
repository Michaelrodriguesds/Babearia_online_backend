// Durante a manutenção com bloqueio, o sistema responde 503 para clientes e
// barbeiros. Continuam funcionando: /health, /status, /relatos, /auth/login,
// /admin (você) e /webhooks (para nenhum Pix pago se perder).
const { avisoPublico } = require('../services/sistema');

const LIBERADAS = [/^\/health/, /^\/status/, /^\/relatos/, /^\/auth\/login/, /^\/admin/, /^\/webhooks/];
// o cliente que está na tela do Pix continua vendo se o pagamento foi confirmado
const LIBERADAS_GET = [/^\/publico\/agendamentos\/[0-9a-f]{24}$/];

async function bloquearEmManutencao(req, res, next) {
  if (LIBERADAS.some((r) => r.test(req.path))) return next();
  if (req.method === 'GET' && LIBERADAS_GET.some((r) => r.test(req.path))) return next();
  try {
    const aviso = await avisoPublico();
    if (aviso?.bloqueando) {
      return res.status(503).json({ erro: aviso.mensagem, manutencao: true, fim: aviso.fim });
    }
  } catch {
    // se não der para ler o aviso, não trava o sistema
  }
  next();
}

module.exports = { bloquearEmManutencao };
