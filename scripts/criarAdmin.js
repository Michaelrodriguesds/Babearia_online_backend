// Cria (ou atualiza a senha de) o seu usuário de administrador.
// Uso: npm run criar-admin -- seu@email.com SuaSenhaForte123 "Seu Nome"
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../src/config/env');
const { Usuario } = require('../src/models');

async function main() {
  const [email, senha, nome = 'Administrador'] = process.argv.slice(2);
  if (!email || !senha || senha.length < 8) {
    console.log('\nUso: npm run criar-admin -- seu@email.com SuaSenhaForte123 "Seu Nome"');
    console.log('(a senha precisa ter pelo menos 8 caracteres)\n');
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri);
  const senhaHash = await bcrypt.hash(senha, 10);
  await Usuario.updateOne(
    { email: email.toLowerCase() },
    { $set: { nome, papel: 'admin', senhaHash }, $unset: { barbeariaId: 1 } },
    { upsert: true }
  );
  console.log(`\n✅ Admin pronto: ${email.toLowerCase()}\n`);
  await mongoose.disconnect();
}

main().catch((erro) => {
  console.error('❌', erro.message);
  process.exit(1);
});
