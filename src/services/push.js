// Notificações push no celular (GRÁTIS, sem WhatsApp).
// Funciona no Android e no iPhone (iOS 16.4+ com o app adicionado à tela inicial).
const webpush = require('web-push');
const { PushInscricao } = require('../models');
const { vapid } = require('../config/env');

const ativo = Boolean(vapid.publica && vapid.privada);
if (ativo) webpush.setVapidDetails(`mailto:${vapid.email}`, vapid.publica, vapid.privada);

/** Nunca lança erro: push é um aviso extra, não pode quebrar nada */
async function enviarPara(filtro, { titulo, corpo, url }) {
  if (!ativo) {
    console.log(`🔔 [Push simulado] ${titulo} — ${corpo}`);
    return;
  }
  try {
    const inscricoes = await PushInscricao.find(filtro).lean();
    const carga = JSON.stringify({ titulo, corpo, url });
    await Promise.all(
      inscricoes.map(async (i) => {
        try {
          await webpush.sendNotification({ endpoint: i.endpoint, keys: i.keys }, carga, { TTL: 60 * 60 * 24 });
        } catch (erro) {
          // 404/410 = celular desinstalou ou negou: remove a inscrição
          if (erro.statusCode === 404 || erro.statusCode === 410) await PushInscricao.deleteOne({ _id: i._id });
          else console.error('❌ Push falhou:', erro.statusCode || erro.message);
        }
      })
    );
  } catch (erro) {
    console.error('❌ Push indisponível:', erro.message);
  }
}

// Para o barbeiro de uma barbearia
function enviarPush(barbeariaId, { titulo, corpo, url = '/painel' }) {
  return enviarPara({ barbeariaId }, { titulo, corpo, url });
}

// Para você (admin)
function enviarPushAdmin({ titulo, corpo, url = '/admin' }) {
  return enviarPara({ admin: true }, { titulo, corpo, url });
}

module.exports = { enviarPush, enviarPushAdmin, pushAtivo: ativo };
