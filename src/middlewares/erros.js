// Respostas de erro padronizadas: { erro: "mensagem", detalhes?: [...] }
const { ErroApp } = require('../utils/erros');

function rotaNaoEncontrada(_req, res) {
  res.status(404).json({ erro: 'Rota não encontrada.' });
}

// eslint-disable-next-line no-unused-vars
function tratarErros(erro, _req, res, _next) {
  if (erro instanceof ErroApp) return res.status(erro.status).json({ erro: erro.message, detalhes: erro.detalhes });
  if (erro.name === 'CastError') return res.status(400).json({ erro: 'Identificador inválido.' });
  if (erro.name === 'ValidationError') return res.status(400).json({ erro: 'Dados inválidos.', detalhes: Object.values(erro.errors).map((e) => e.message) });
  if (erro.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido.' });
  console.error('💥 Erro inesperado:', erro);
  res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
}

module.exports = { rotaNaoEncontrada, tratarErros };
