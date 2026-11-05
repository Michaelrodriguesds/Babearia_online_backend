// Agendamentos (e bloqueios de agenda feitos pelo barbeiro)
const { Schema, model } = require('mongoose');

const STATUS = [
  'pendente', // horário reservado, aguardando Pix
  'confirmado', // pago (ou pagamento no local)
  'cancelado',
  'expirado', // Pix não pago a tempo — horário liberado
  'concluido', // horário já passou
  'bloqueado', // barbeiro bloqueou a agenda (tipo = bloqueio)
  'conflito', // Pix pago depois de expirar e o horário já tinha sido ocupado
];

const agendamentoSchema = new Schema(
  {
    barbeariaId: { type: Schema.Types.ObjectId, ref: 'Barbearia', required: true },
    barbeiroId: { type: Schema.Types.ObjectId, default: null }, // reservado para planos com mais barbeiros
    tipo: { type: String, enum: ['cliente', 'bloqueio'], default: 'cliente' },

    servicoId: { type: Schema.Types.ObjectId, ref: 'Servico' },
    clienteId: { type: Schema.Types.ObjectId, ref: 'Cliente' },
    // cópias para não precisar de consultas extras ao listar
    servicoNome: String,
    clienteNome: String,
    clienteWhatsapp: String,
    motivo: String, // usado em bloqueios

    inicio: { type: Date, required: true },
    fim: { type: Date, required: true },

    valorTotal: { type: Number, default: 0 },
    valorCobrado: { type: Number, default: 0 }, // integral, sinal ou 0 (pagar no local)

    status: { type: String, enum: STATUS, default: 'pendente' },
    expiraEm: Date, // até quando o Pix pode ser pago

    pagamento: {
      modo: { type: String, enum: ['manual', 'mercadopago', 'local', null], default: null },
      mpPaymentId: String,
      pixCopiaCola: String,
      pagoEm: Date,
      confirmadoPor: { type: String, enum: ['webhook', 'barbeiro', null], default: null },
    },

    codigoCancelamento: { type: String, select: false },
    lembrete24hEnviado: { type: Boolean, default: false },
    lembrete2hEnviado: { type: Boolean, default: false },
  },
  { timestamps: true }
);

agendamentoSchema.index({ barbeariaId: 1, inicio: 1 }); // agenda do dia / painel
agendamentoSchema.index({ status: 1, expiraEm: 1 }); // job de expiração
agendamentoSchema.index({ status: 1, inicio: 1 }); // job de lembretes
agendamentoSchema.index({ 'pagamento.mpPaymentId': 1 }, { sparse: true });

module.exports = model('Agendamento', agendamentoSchema);
module.exports.STATUS = STATUS;
