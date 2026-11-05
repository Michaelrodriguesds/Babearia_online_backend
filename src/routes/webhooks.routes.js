// Mercado Pago avisa aqui quando um Pix é pago.
// Segurança: NÃO confiamos no conteúdo do aviso. Consultamos o pagamento
// direto no Mercado Pago com o token da barbearia antes de confirmar.
const { Router } = require('express');
const mongoose = require('mongoose');
const { Barbearia, Agendamento } = require('../models');
const { buscarPagamento } = require('../services/mercadoPago');
const { confirmarPagamento } = require('../services/agendamentos');
const { descriptografar } = require('../utils/cripto');

const router = Router();

async function processarAvisoMercadoPago(barbeariaId, pagamentoId) {
  const barbearia = await Barbearia.findById(barbeariaId).select('+pagamento.mpAccessTokenCripto').lean();
  const cripto = barbearia?.pagamento?.mpAccessTokenCripto;
  if (!cripto) return;

  const pagamento = await buscarPagamento(descriptografar(cripto), pagamentoId);
  if (!pagamento || pagamento.status !== 'approved') return;

  const agendamentoId = pagamento.external_reference;
  if (!mongoose.isValidObjectId(agendamentoId)) return;

  const ag = await Agendamento.findOne({ _id: agendamentoId, barbeariaId }).select('valorCobrado').lean();
  if (!ag) return;
  if (Number(pagamento.transaction_amount) + 0.001 < ag.valorCobrado) {
    console.warn(`⚠️ Pix com valor menor que o esperado no agendamento ${agendamentoId}`);
    return;
  }
  await confirmarPagamento(agendamentoId, { por: 'webhook', mpPaymentId: String(pagamento.id) });
  console.log(`✅ Pix confirmado automaticamente: agendamento ${agendamentoId}`);
}

router.post('/mercadopago/:barbeariaId', (req, res) => {
  res.sendStatus(200); // responde rápido; o Mercado Pago reenvia se demorar

  const tipo = req.body?.type || req.query.type || req.query.topic;
  const pagamentoId = req.body?.data?.id || req.query['data.id'] || req.query.id;
  if (tipo !== 'payment' || !pagamentoId || !mongoose.isValidObjectId(req.params.barbeariaId)) return;

  processarAvisoMercadoPago(req.params.barbeariaId, pagamentoId).catch((erro) =>
    console.error('❌ Erro ao processar webhook do Mercado Pago:', erro.message)
  );
});

module.exports = router;
