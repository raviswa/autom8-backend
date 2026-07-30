'use strict';

/**
 * Fixture regression for kitchen order display.
 * Run: node src/helpers/__tests__/orderDisplay.test.js
 */

const { formatKitchenOrderNo } = require('../orderDisplay');

const cases = [
  ['ORD-153-2228b7cf', null, '153'],
  ['ORD-153-R2', null, '153-2'],
  ['ORD-098', null, '098'],
  ['ORD-WA-1722345678901', null, '45678901'],
  ['ORD-B-2228b7cf', null, null], // hex→decimal last 8 — computed below
  ['ORD-1722345678901', null, '1722345678901'], // matched as ORD-{token} digits
  ['garbage', 'T-2507-153', '2507153'],
  ['', 'T-98', '98'],
  [null, null, '—'],
];

// ORD-B-{hex} → BigInt decimal slice(-8)
cases[4][2] = BigInt('0x2228b7cf').toString().slice(-8);

let failed = 0;
for (const [orderNumber, tokenNumber, expected] of cases) {
  const got = formatKitchenOrderNo(orderNumber, tokenNumber);
  if (got !== expected) {
    console.error(`FAIL: formatKitchenOrderNo(${JSON.stringify(orderNumber)}, ${JSON.stringify(tokenNumber)})`);
    console.error(`  expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    failed += 1;
  } else {
    console.log(`OK: ${orderNumber || '(empty)'} → ${got}`);
  }
}

if (failed) {
  console.error(`\n${failed} fixture(s) failed`);
  process.exit(1);
}
console.log('\nAll orderDisplay fixtures passed');
