'use strict';

/**
 * Quick sanity checks for subscriptionPricing (run: node src/helpers/__tests__/subscriptionPricing.smoke.js)
 */

const {
  calculateMonthlyPrice,
  assertSinglePackagedCatalogLob,
  parseSupplyEnabledFlag,
  LOB_PRICE_INR,
} = require('../subscriptionPricing');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(LOB_PRICE_INR === 500, 'LOB_PRICE_INR');
assert(calculateMonthlyPrice({ lob_type: 'retail', supply_enabled: false }) === 500, 'retail only');
assert(calculateMonthlyPrice({ lob_type: 'retail', supply_enabled: true }) === 1000, 'retail+supply');
assert(calculateMonthlyPrice({ lob_type: 'b2b', supply_enabled: true }) === 500, 'b2b implied');
assert(calculateMonthlyPrice({ lob_type: 'b2b', supply_enabled: false }) === 500, 'b2b always 1');
assert(parseSupplyEnabledFlag({ supply_enabled: true }, 'retail') === true, 'flag true');
assert(parseSupplyEnabledFlag({}, 'b2b') === true, 'b2b implies');

let threw = false;
try {
  assertSinglePackagedCatalogLob({ business_verticals: ['food_products', 'retail'] });
} catch (e) {
  threw = true;
  assert(/food_products and retail cannot both be selected/.test(e.message), e.message);
}
assert(threw, 'multi packaged must throw');

assertSinglePackagedCatalogLob({ lob_type: 'retail', supply_enabled: true });
assertSinglePackagedCatalogLob({ business_verticals: ['retail', 'b2b'] });

console.log('subscriptionPricing smoke OK');
