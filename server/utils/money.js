// Kora trades USDC for US dollars. Totals and limits show as dollars (cents
// only when there are some); a price per USDC needs three decimals, because
// USDC sits within a fraction of a cent of one dollar.
const usd = (n) => {
  const cents = Math.round(Number(n) * 100) / 100;
  const whole = Number.isInteger(cents);
  return '$' + cents.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
};
const price = (n) => '$' + Number(n).toFixed(3);

module.exports = { usd, price };
