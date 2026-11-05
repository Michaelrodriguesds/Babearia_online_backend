// Gera todos os segredos do .env. Uso: npm run gerar-chaves
const crypto = require('crypto');
const webpush = require('web-push');

const vapid = webpush.generateVAPIDKeys();

console.log('\nCopie estas linhas para o seu arquivo .env (backend):\n');
console.log(`JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`);
console.log(`ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}`);
console.log(`VAPID_PUBLIC_KEY=${vapid.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapid.privateKey}`);
console.log('\n⚠️  Guarde essas chaves. Se ENCRYPTION_KEY mudar, os tokens do Mercado Pago salvos param de funcionar.');
console.log('⚠️  Se as chaves VAPID mudarem, os barbeiros precisam ativar as notificações de novo.\n');
