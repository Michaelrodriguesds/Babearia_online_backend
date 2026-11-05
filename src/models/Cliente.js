// Clientes de cada barbearia (criados automaticamente no 1º agendamento)
const { Schema, model } = require('mongoose');

const clienteSchema = new Schema(
  {
    barbeariaId: { type: Schema.Types.ObjectId, ref: 'Barbearia', required: true },
    nome: { type: String, required: true, trim: true },
    whatsapp: { type: String, required: true },
    email: { type: String, default: '' },
    totalAgendamentos: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// O mesmo WhatsApp é o mesmo cliente dentro de uma barbearia
clienteSchema.index({ barbeariaId: 1, whatsapp: 1 }, { unique: true });

module.exports = model('Cliente', clienteSchema);
