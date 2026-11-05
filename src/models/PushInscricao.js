// Celulares que aceitaram receber notificações (push grátis):
// do barbeiro (barbeariaId preenchido) ou seu, o admin (admin = true)
const { Schema, model } = require('mongoose');

const pushSchema = new Schema(
  {
    barbeariaId: { type: Schema.Types.ObjectId, ref: 'Barbearia', default: null },
    admin: { type: Boolean, default: false },
    usuarioId: { type: Schema.Types.ObjectId, ref: 'Usuario', required: true },
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
  },
  { timestamps: true }
);

pushSchema.index({ barbeariaId: 1 });
pushSchema.index({ admin: 1 });

module.exports = model('PushInscricao', pushSchema);
