// Datas no fuso de Brasília, telefones e textos
const { DateTime } = require('luxon');
const { fuso } = require('../config/env');

// "sáb. 25/10 às 14:00"
function dataHoraBR(data) {
  return DateTime.fromJSDate(new Date(data)).setZone(fuso).setLocale('pt-BR').toFormat("ccc dd/LL 'às' HH:mm");
}

function hojeISO() {
  return DateTime.now().setZone(fuso).toISODate();
}

// Deixa só números e coloca o 55 do Brasil quando faltar: 21999998888 -> 5521999998888
function normalizarTelefone(telefone) {
  const digitos = String(telefone || '').replace(/\D/g, '');
  if (digitos.length === 10 || digitos.length === 11) return `55${digitos}`;
  return digitos;
}

function semAcentos(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "Barbearia do Zé" -> "barbearia-do-ze"
function gerarSlug(texto) {
  return semAcentos(texto)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function reais(valor) {
  return Number(valor || 0).toFixed(2).replace('.', ',');
}

module.exports = { dataHoraBR, hojeISO, normalizarTelefone, semAcentos, gerarSlug, reais };
