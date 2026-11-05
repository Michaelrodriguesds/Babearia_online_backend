// Valida body/query com zod. O resultado limpo fica em req.validado
const { ErroApp } = require('../utils/erros');

const validar = (schema, origem = 'body') => (req, _res, next) => {
  const resultado = schema.safeParse(req[origem] ?? {});
  if (!resultado.success) {
    const detalhes = resultado.error.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message }));
    return next(new ErroApp(400, 'Dados inválidos.', detalhes));
  }
  req.validado = resultado.data;
  next();
};

module.exports = { validar };
