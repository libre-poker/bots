// cashier/book.js — the cashier's book as a WebLedger document
// (webledgers.org): entries map URIs to satoshi balances; hands,
// withdrawals, and deposits ride along as custom fields, which the
// webledgers spec explicitly preserves. A pre-webledgers book (a plain
// balances object) migrates once on load; the old file is kept as
// ledger.v0.json so the migration is inspectable.
import fs from 'node:fs';
import path from 'node:path';

export function loadBook(dir, seedBalances) {
  const file = path.join(dir, 'ledger.json');
  let book;
  try { book = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { book = { seq: 0, balances: { ...seedBalances }, hands: {} }; }
  if (book.balances) {
    fs.writeFileSync(path.join(dir, 'ledger.v0.json'), JSON.stringify(book, null, 2));
    book = {
      '@context': 'https://w3id.org/webledgers',
      type: 'WebLedger',
      id: 'https://librepoker.org/play/cash.html#ledger',
      name: 'Libre Poker cash ledger (testnet4)',
      defaultCurrency: 'satoshi',
      created: Math.floor(Date.now() / 1000),
      updated: Math.floor(Date.now() / 1000),
      seq: book.seq || 0,
      hands: book.hands || {},
      withdrawals: book.withdrawals || {},
      deposits: {},
      entries: Object.entries(book.balances).map(([url, v]) => ({ type: 'Entry', url, amount: String(v) })),
    };
    fs.writeFileSync(file, JSON.stringify(book, null, 2));
    console.log('[cashier] book migrated to WebLedger format (v0 keepsake saved)');
  }
  const save = () => { book.updated = Math.floor(Date.now() / 1000); fs.writeFileSync(file, JSON.stringify(book, null, 2)); };
  const bal = (uri) => { const e = book.entries.find((x) => x.url === uri); return e ? parseInt(e.amount, 10) : 0; };
  const creditBal = (uri, delta) => {
    const e = book.entries.find((x) => x.url === uri);
    if (e) e.amount = String(parseInt(e.amount, 10) + delta);
    else book.entries.push({ type: 'Entry', url: uri, amount: String(delta) });
  };
  const balancesView = () => Object.fromEntries(book.entries.map((e) => [e.url, parseInt(e.amount, 10)]));
  return { book, save, bal, creditBal, balancesView };
}
