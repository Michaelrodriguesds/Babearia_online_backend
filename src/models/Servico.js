// Serviços que cada barbearia oferece (corte, barba, etc.)
const { Schema, model } = require('mongoose');

const servicoSchema = new Schema(
  {
    barbeariaId: { type: Schema.Types.ObjectId, ref: 'Barbearia', required: true },
    nome: { type: String, required: true, trim: true, maxlength: 60 },
    descricao: { type: String, default: '', maxlength: 200 },
    preco: { type: Number, required: true, min: 0, set: (v) => Math.round(v * 100) / 100 }, // em reais
    duracaoMinutos: { type: Number, required: true, min: 15, max: 480 },
    ativo: { type: Boolean, default: true },
    ordem: { type: Number, default: 0 },
  },
  { timestamps: true }
);

servicoSchema.index({ barbeariaId: 1, ativo: 1, ordem: 1 });

module.exports = model('Servico', servicoSchema);
