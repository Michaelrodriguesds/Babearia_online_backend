// Contas de dinheiro SEMPRE em centavos inteiros (evita erro de 1 centavo do
// ponto flutuante, ex.: 0,1 + 0,2 = 0,30000000000000004).
// ATENÇÃO: a mesma lógica existe no frontend (src/dinheiro.js). Se mudar aqui,
// mude lá também — o teste "npm run testar" confere que os dois batem.

const paraCentavos = (reais) => Math.round(Number(reais || 0) * 100);
const paraReais = (centavos) => centavos / 100;

/** Soma uma lista de preços em reais, sem erro de arredondamento */
function somarPrecos(precos) {
  return paraReais(precos.reduce((total, preco) => total + paraCentavos(preco), 0));
}

/**
 * Quanto cobrar no Pix, conforme a regra da barbearia:
 *  - 'local'  → 0 (paga na barbearia)
 *  - 'sinal'  → percentual do total ou valor fixo; NUNCA maior que o total
 *  - outro    → valor total
 */
function calcularCobranca(regras, preco) {
  const total = paraCentavos(preco);
  if (!regras || regras.cobranca === 'local' || total <= 0) return 0;
  if (regras.cobranca === 'sinal') {
    let sinal;
    if (regras.sinalTipo === 'fixo') {
      sinal = paraCentavos(regras.sinalValor);
    } else {
      const percentual = Math.min(Math.max(Number(regras.sinalValor) || 0, 0), 100);
      sinal = Math.round((total * percentual) / 100);
    }
    return paraReais(Math.min(Math.max(sinal, 0), total));
  }
  return paraReais(total);
}

module.exports = { paraCentavos, paraReais, somarPrecos, calcularCobranca };
