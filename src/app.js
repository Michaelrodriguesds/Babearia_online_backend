// Monta a aplicação Express (separado do server.js para facilitar testes)
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const { frontendUrls } = require('./config/env');
const { limiteGeral } = require('./middlewares/limites');
const { rotaNaoEncontrada, tratarErros } = require('./middlewares/erros');
const { bloquearEmManutencao } = require('./middlewares/manutencao');
const { avisoPublico } = require('./services/sistema');

const app = express();

app.set('trust proxy', 1); // necessário no Render (IP real do cliente)
app.use(helmet());
app.use(cors({ origin: frontendUrls }));
app.use(compression()); // respostas menores = mais rápidas (melhoria do Glamour)
app.use(express.json({ limit: '100kb' }));

// Rota leve para o "ping" que mantém a API acordada no Render
app.get('/health', (_req, res) => res.json({ ok: true, horario: new Date().toISOString() }));

// Aviso geral / manutenção: o app consulta ao abrir
app.get('/status', async (_req, res, next) => {
  try {
    res.json({ aviso: await avisoPublico() });
  } catch (erro) {
    next(erro);
  }
});

app.use('/webhooks', require('./routes/webhooks.routes'));
app.use(bloquearEmManutencao); // trava clientes e barbeiros durante a manutenção
app.use(limiteGeral);
app.use('/relatos', require('./routes/relatos.routes'));
app.use('/auth', require('./routes/auth.routes'));
app.use('/painel', require('./routes/painel.routes'));
app.use('/admin', require('./routes/admin.routes'));
app.use('/publico', require('./routes/publico.routes'));

app.use(rotaNaoEncontrada);
app.use(tratarErros);

module.exports = app;
