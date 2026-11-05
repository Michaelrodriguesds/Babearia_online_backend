// Relatos de bugs, erros e sugestões (de clientes, barbeiros ou capturados sozinhos)
const { Schema, model } = require('mongoose');

const relatoSchema = new Schema(
  {
    origem: { type: String, enum: ['cliente', 'barbeiro', 'automatico'], required: true },
    tipo: { type: String, enum: ['problema', 'sugestao', 'outro', 'erro_automatico'], required: true },
    mensagem: { type: String, required: true, maxlength: 2000 },
    contato: { type: String, default: '', maxlength: 120 }, // WhatsApp ou e-mail, se a pessoa quiser retorno

    barbeariaId: { type: Schema.Types.ObjectId, ref: 'Barbearia', default: null },
    barbeariaNome: { type: String, default: '' },
    usuarioId: { type: Schema.Types.ObjectId, ref: 'Usuario', default: null },

    pagina: { type: String, default: '', maxlength: 300 }, // onde a pessoa estava
    navegador: { type: String, default: '', maxlength: 300 }, // celular/navegador usado
    pilha: { type: String, default: '', maxlength: 4000 }, // detalhes técnicos (erros automáticos)

    // Erros automáticos iguais viram um relato só, contando as vezes
    assinatura: { type: String, default: null },
    ocorrencias: { type: Number, default: 1 },
    ultimaVez: { type: Date, default: Date.now },

    status: { type: String, enum: ['novo', 'analisando', 'resolvido', 'descartado'], default: 'novo' },
    resposta: { type: String, default: '', maxlength: 1000 }, // o barbeiro vê esta resposta
  },
  { timestamps: true }
);

relatoSchema.index({ status: 1, ultimaVez: -1 });
relatoSchema.index({ barbeariaId: 1, createdAt: -1 });
relatoSchema.index({ assinatura: 1 }, { sparse: true });

module.exports = model('Relato', relatoSchema);
