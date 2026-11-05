// Login do barbeiro (dono) e do desenvolvedor (admin)
const { Schema, model } = require('mongoose');

const usuarioSchema = new Schema(
  {
    nome: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    senhaHash: { type: String, required: true, select: false },
    papel: { type: String, enum: ['dono', 'admin'], default: 'dono' },
    barbeariaId: { type: Schema.Types.ObjectId, ref: 'Barbearia' }, // vazio para admin
  },
  { timestamps: true }
);

module.exports = model('Usuario', usuarioSchema);
