// Criptografa tokens sensíveis (ex.: token do Mercado Pago do barbeiro)
// antes de salvar no banco. Algoritmo AES-256-GCM.
const crypto = require('crypto');
const { chaveCriptografia } = require('../config/env');

const CHAVE = Buffer.from(chaveCriptografia, 'hex');

function criptografar(texto) {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', CHAVE, iv);
  const dados = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return [iv, tag, dados].map((b) => b.toString('base64')).join('.');
}

function descriptografar(pacote) {
  const [iv, tag, dados] = pacote.split('.').map((p) => Buffer.from(p, 'base64'));
  const decifra = crypto.createDecipheriv('aes-256-gcm', CHAVE, iv);
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(dados), decifra.final()]).toString('utf8');
}

module.exports = { criptografar, descriptografar };
