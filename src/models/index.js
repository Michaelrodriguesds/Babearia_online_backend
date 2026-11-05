// Carrega todos os modelos de uma vez (necessário antes de criar os índices)
module.exports = {
  Barbearia: require('./Barbearia'),
  Usuario: require('./Usuario'),
  Servico: require('./Servico'),
  Cliente: require('./Cliente'),
  Agendamento: require('./Agendamento'),
  Slot: require('./Slot'),
  PushInscricao: require('./PushInscricao'),
  Relato: require('./Relato'),
  Config: require('./Config'),
};
