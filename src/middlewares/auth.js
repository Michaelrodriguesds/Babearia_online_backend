// Login por token JWT (enviado no cabeçalho Authorization: Bearer <token>)
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/env');
const { ErroApp } = require('../utils/erros');

function gerarToken(usuario) {
  return jwt.sign(
    { sub: String(usuario._id), papel: usuario.papel, bid: usuario.barbeariaId ? String(usuario.barbeariaId) : null },
    jwtSecret,
    { expiresIn: '7d' }
  );
}

function exigirLogin(req, _res, next) {
  const [tipo, token] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Bearer' || !token) return next(new ErroApp(401, 'Faça login para continuar.'));
  try {
    const dados = jwt.verify(token, jwtSecret);
    req.usuario = { id: dados.sub, papel: dados.papel, barbeariaId: dados.bid };
    next();
  } catch {
    next(new ErroApp(401, 'Sua sessão expirou. Faça login novamente.'));
  }
}

// Para rotas abertas: se vier um token válido, identifica quem é; se não, segue sem login
function lerLoginOpcional(req, _res, next) {
  const [tipo, token] = (req.headers.authorization || '').split(' ');
  if (tipo === 'Bearer' && token) {
    try {
      const dados = jwt.verify(token, jwtSecret);
      req.usuario = { id: dados.sub, papel: dados.papel, barbeariaId: dados.bid };
    } catch { /* token vencido: trata como visitante */ }
  }
  next();
}

function exigirDono(req, _res, next) {
  if (req.usuario?.papel !== 'dono' || !req.usuario.barbeariaId) return next(new ErroApp(403, 'Acesso só para barbeiros.'));
  next();
}

function exigirAdmin(req, _res, next) {
  if (req.usuario?.papel !== 'admin') return next(new ErroApp(403, 'Acesso só para o administrador.'));
  next();
}

module.exports = { gerarToken, exigirLogin, exigirDono, exigirAdmin, lerLoginOpcional };
