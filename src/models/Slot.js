// Blocos de 15 minutos ocupados na agenda.
// Um corte de 45 min ocupa 3 blocos. O ÍNDICE ÚNICO abaixo faz o próprio
// banco recusar o segundo agendamento no mesmo horário — mesmo que dois
// clientes cliquem ao mesmo tempo. É isso que bloqueia horário já marcado.
const { Schema, model } = require('mongoose');

const slotSchema = new Schema({
  barbeariaId: { type: Schema.Types.ObjectId, required: true },
  inicio: { type: Date, required: true },
  agendamentoId: { type: Schema.Types.ObjectId, required: true },
});

// Se um dia houver vários barbeiros por barbearia, inclua barbeiroId aqui
slotSchema.index({ barbeariaId: 1, inicio: 1 }, { unique: true });
slotSchema.index({ agendamentoId: 1 });

module.exports = model('Slot', slotSchema);
module.exports.MINUTOS_SLOT = 15;
