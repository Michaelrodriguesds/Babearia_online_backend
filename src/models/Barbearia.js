// Uma barbearia = um barbeiro = um plano mensal
const { Schema, model } = require('mongoose');

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/; // formato HH:mm

const horarioSchema = new Schema(
  {
    dia: { type: Number, min: 0, max: 6, required: true }, // 0 = domingo ... 6 = sábado
    abre: { type: String, match: HORA, required: true },
    fecha: { type: String, match: HORA, required: true },
    pausaInicio: { type: String, match: HORA }, // ex.: almoço
    pausaFim: { type: String, match: HORA },
  },
  { _id: false }
);

// Segunda a sábado, 09:00–19:00, almoço 12:00–13:00
const horariosPadrao = [1, 2, 3, 4, 5, 6].map((dia) => ({
  dia, abre: '09:00', fecha: '19:00', pausaInicio: '12:00', pausaFim: '13:00',
}));

const barbeariaSchema = new Schema(
  {
    nome: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true, lowercase: true }, // link público: /b/<slug>
    whatsapp: { type: String, required: true }, // WhatsApp do barbeiro (recebe os avisos)
    endereco: { type: String, default: '' },
    logoUrl: { type: String, default: '' },
    corPrimaria: { type: String, default: '#111827' },

    horarios: { type: [horarioSchema], default: horariosPadrao },
    folgas: { type: [String], default: [] }, // datas sem atendimento: 'AAAA-MM-DD'

    // ===== Regras de negócio — cada barbearia tem as suas =====
    regras: {
      antecedenciaMinMinutos: { type: Number, default: 60, min: 0 },
      antecedenciaMaxDias: { type: Number, default: 30, min: 1, max: 180 },
      minutosParaPagar: { type: Number, default: 15, min: 5, max: 1440 },
      cobranca: { type: String, enum: ['integral', 'sinal', 'local'], default: 'integral' },
      sinalTipo: { type: String, enum: ['percentual', 'fixo'], default: 'percentual' },
      sinalValor: { type: Number, default: 50, min: 0 },
      cancelamentoAteHoras: { type: Number, default: 2, min: 0 },
      // Lembretes por WhatsApp (cada mensagem tem custo)
      lembrete24h: { type: Boolean, default: true },
      lembrete2h: { type: Boolean, default: false },
    },

    // ===== Como o Pix é gerado =====
    pagamento: {
      modo: { type: String, enum: ['manual', 'mercadopago'], default: 'manual' },
      chavePix: { type: String, default: '' }, // modo manual
      nomeRecebedor: { type: String, default: '' }, // aparece no app do banco do cliente
      cidade: { type: String, default: '' },
      mpAccessTokenCripto: { type: String, select: false }, // token do Mercado Pago, criptografado
    },

    // ===== Licença (controle do desenvolvedor) =====
    licenca: {
      plano: { type: String, enum: ['teste', 'pago'], default: 'teste' },
      acessoAte: { type: Date, required: true },
      ultimoAvisoEm: { type: String, default: '' }, // 'AAAA-MM-DD' do último aviso enviado
      observacao: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

barbeariaSchema.index({ 'licenca.acessoAte': 1 });

module.exports = model('Barbearia', barbeariaSchema);
