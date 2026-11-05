// Ponto de entrada: conecta no banco, liga as tarefas e sobe a API
const config = require('./config/env');
require('./models'); // registra os modelos antes de criar os índices
const { conectarBanco } = require('./config/db');
const { iniciarTarefas } = require('./jobs/tarefas');
const app = require('./app');

async function iniciar() {
  try {
    await conectarBanco(config.mongoUri);
    iniciarTarefas();
    app.listen(config.porta, () => console.log(`🚀 API rodando em http://localhost:${config.porta}`));
  } catch (erro) {
    console.error('❌ Não foi possível iniciar a API:', erro.message);
    process.exit(1);
  }
}

iniciar();
