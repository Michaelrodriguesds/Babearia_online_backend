// Configurações gerais do sistema (um único documento). Hoje guarda o aviso/manutenção.
const { Schema, model } = require('mongoose');

const configSchema = new Schema(
  {
    chave: { type: String, required: true, unique: true }, // sempre 'sistema'
    aviso: {
      ativo: { type: Boolean, default: false },
      tipo: { type: String, enum: ['informativo', 'manutencao'], default: 'informativo' },
      mensagem: { type: String, default: '', maxlength: 500 },
      inicio: { type: Date, default: null }, // vazio = já começou
      fim: { type: Date, default: null }, // vazio = até você desligar. Passou do fim, some sozinho
      bloquear: { type: Boolean, default: false }, // manutenção: trava o sistema para todos (menos você)
      mostrarPara: { type: String, enum: ['todos', 'barbeiros'], default: 'todos' },
      atualizadoEm: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

module.exports = model('Config', configSchema);
