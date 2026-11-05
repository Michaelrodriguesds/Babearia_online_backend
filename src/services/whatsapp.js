// Envio de mensagens pela WhatsApp Cloud API (oficial da Meta).
// Sem WHATSAPP_TOKEN no .env, a mensagem só aparece no terminal (modo simulado).
const { whatsapp } = require('../config/env');
const { normalizarTelefone } = require('../utils/formatos');

// A Meta não aceita quebra de linha, tab ou mais de 4 espaços seguidos nos parâmetros
function limparParametro(valor) {
  return String(valor ?? '').replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 1000) || '-';
}

/**
 * Envia um template aprovado na Meta.
 * Nunca lança erro: uma falha no WhatsApp não pode desfazer um agendamento.
 */
async function enviarTemplate(telefone, nomeTemplate, parametros = []) {
  const para = normalizarTelefone(telefone);
  const params = parametros.map(limparParametro);

  if (!whatsapp.token || !whatsapp.phoneNumberId) {
    console.log(`📱 [WhatsApp simulado] para ${para} | ${nomeTemplate} |`, params.join(' | '));
    return { simulado: true };
  }

  try {
    const resposta = await fetch(
      `https://graph.facebook.com/${whatsapp.versao}/${whatsapp.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${whatsapp.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: para,
          type: 'template',
          template: {
            name: nomeTemplate,
            language: { code: whatsapp.idioma },
            components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
          },
        }),
      }
    );
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      console.error(`❌ WhatsApp falhou (${nomeTemplate} -> ${para}):`, dados?.error?.message || resposta.status);
      return { ok: false };
    }
    return { ok: true, id: dados?.messages?.[0]?.id };
  } catch (erro) {
    console.error('❌ WhatsApp indisponível:', erro.message);
    return { ok: false };
  }
}

module.exports = { enviarTemplate };
