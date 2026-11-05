// Conexão única com o MongoDB, reaproveitada por toda a API
// (melhoria do Glamour: pool de conexões ajustado + timeouts claros)
const mongoose = require('mongoose');

async function conectarBanco(uri) {
  mongoose.set('strictQuery', true);

  await mongoose.connect(uri, {
    maxPoolSize: 10, // até 10 consultas em paralelo
    minPoolSize: 2, // mantém 2 conexões prontas (evita lentidão na 1ª requisição)
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
  });

  // Garante que todos os índices existem (o índice único dos horários
  // é o que impede agendamento duplicado — não pode faltar)
  await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));

  console.log('✅ MongoDB conectado e índices verificados');
}

module.exports = { conectarBanco };
