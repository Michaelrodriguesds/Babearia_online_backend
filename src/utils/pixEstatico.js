// Gera o "Pix copia e cola" (BR Code do Banco Central) a partir da chave Pix
// do barbeiro, JÁ COM O VALOR do serviço. Não precisa de banco nem gateway.
// O cliente só cola no app do banco e paga o valor certo.
const { semAcentos } = require('./formatos');

function campo(id, valor) {
  return id + String(valor.length).padStart(2, '0') + valor;
}

// CRC16-CCITT exigido pelo padrão do Pix
function crc16(texto) {
  let crc = 0xffff;
  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function limpar(texto, max) {
  return semAcentos(texto).toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, max) || 'NA';
}

/**
 * @param {object} p
 * @param {string} p.chave  CPF, CNPJ, e-mail, telefone (+5521...) ou chave aleatória
 * @param {number} p.valor  em reais (ex.: 35)
 * @param {string} p.nome   nome do recebedor (até 25 letras)
 * @param {string} p.cidade cidade do recebedor (até 15 letras)
 * @param {string} [p.txid] identificador (até 25 letras/números)
 */
function gerarPixCopiaCola({ chave, valor, nome, cidade, txid }) {
  const contaPix = campo('00', 'br.gov.bcb.pix') + campo('01', chave.trim());
  const idTransacao = (txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';

  const semCrc =
    campo('00', '01') +
    campo('26', contaPix) +
    campo('52', '0000') +
    campo('53', '986') + // real brasileiro
    campo('54', Number(valor).toFixed(2)) +
    campo('58', 'BR') +
    campo('59', limpar(nome, 25)) +
    campo('60', limpar(cidade, 15)) +
    campo('62', campo('05', idTransacao)) +
    '6304';

  return semCrc + crc16(semCrc);
}

module.exports = { gerarPixCopiaCola, crc16 };
