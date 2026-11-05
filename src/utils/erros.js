// Erro com status HTTP. Use: throw new ErroApp(409, 'Horário indisponível')
class ErroApp extends Error {
  constructor(status, mensagem, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

function ehDuplicado(erro) {
  return erro?.code === 11000 || /E11000/.test(erro?.message || '');
}

module.exports = { ErroApp, ehDuplicado };
