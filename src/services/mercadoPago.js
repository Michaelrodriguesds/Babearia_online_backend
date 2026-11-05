// Pix automático pelo Mercado Pago (cada barbearia usa a PRÓPRIA conta:
// o dinheiro cai direto para o barbeiro e o pagamento é confirmado sozinho)
const { ErroApp } = require('../utils/erros');

const BASE = 'https://api.mercadopago.com';

async function criarPix({ accessToken, valor, descricao, referencia, emailPagador, expiraEm, urlNotificacao }) {
  const corpo = {
    transaction_amount: Number(valor.toFixed(2)),
    description: descricao.slice(0, 250),
    payment_method_id: 'pix',
    payer: { email: emailPagador },
    external_reference: referencia, // id do agendamento
    date_of_expiration: expiraEm, // ISO com fuso, ex.: 2026-10-24T15:30:00.000-03:00
  };
  // O Mercado Pago só aceita URL pública com https (não funciona com localhost)
  if (urlNotificacao?.startsWith('https://')) corpo.notification_url = urlNotificacao;

  const resposta = await fetch(`${BASE}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': referencia, // evita cobrança duplicada se repetir a chamada
    },
    body: JSON.stringify(corpo),
  });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    console.error('❌ Mercado Pago recusou o Pix:', dados?.message || resposta.status);
    throw new ErroApp(502, 'Não foi possível gerar o Pix agora. Tente novamente em instantes.');
  }

  const tx = dados.point_of_interaction?.transaction_data || {};
  return {
    mpPaymentId: String(dados.id),
    copiaCola: tx.qr_code,
    qrCodeBase64: tx.qr_code_base64,
  };
}

async function buscarPagamento(accessToken, pagamentoId) {
  const resposta = await fetch(`${BASE}/v1/payments/${encodeURIComponent(pagamentoId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resposta.ok) return null;
  return resposta.json();
}

module.exports = { criarPix, buscarPagamento };
