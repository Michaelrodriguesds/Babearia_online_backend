// Lê e valida as variáveis do arquivo .env
require('dotenv').config();

function obrigatoria(nome) {
  const valor = process.env[nome];
  if (!valor || valor.startsWith('cole_aqui')) {
    console.error(`\n❌ A variável ${nome} não foi definida no arquivo .env\n`);
    process.exit(1);
  }
  return valor;
}

const chaveCriptografia = obrigatoria('ENCRYPTION_KEY');
if (!/^[0-9a-f]{64}$/i.test(chaveCriptografia)) {
  console.error('\n❌ ENCRYPTION_KEY precisa ter 64 caracteres hexadecimais. Rode: npm run gerar-chaves\n');
  process.exit(1);
}

module.exports = {
  porta: Number(process.env.PORT) || 3000,
  producao: process.env.NODE_ENV === 'production',
  mongoUri: obrigatoria('MONGODB_URI'),
  jwtSecret: obrigatoria('JWT_SECRET'),
  chaveCriptografia,
  frontendUrls: (process.env.FRONTEND_URL || 'http://localhost:5173').split(',').map((u) => u.trim()),
  apiUrl: (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, ''),
  fuso: 'America/Sao_Paulo',
  diasTeste: Number(process.env.DIAS_TESTE) || 30,
  diasPlano: Number(process.env.DIAS_PLANO) || 30,
  suporteWhatsapp: process.env.SUPORTE_WHATSAPP || '',
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    versao: process.env.WHATSAPP_API_VERSION || 'v21.0',
    idioma: 'pt_BR',
  },
  // Avisar o barbeiro também pelo WhatsApp (custa por mensagem). Por padrão ele
  // recebe só o push no celular, que é grátis.
  avisarBarbeiroWhatsapp: process.env.WHATSAPP_AVISAR_BARBEIRO === 'true',
  pagadorEmailPadrao: process.env.PAGADOR_EMAIL_PADRAO || 'pagamentos@exemplo.com',
  vapid: {
    publica: process.env.VAPID_PUBLIC_KEY || '',
    privada: process.env.VAPID_PRIVATE_KEY || '',
    email: process.env.VAPID_EMAIL || 'suporte@exemplo.com',
  },
};
