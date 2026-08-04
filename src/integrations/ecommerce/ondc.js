'use strict';

/**
 * ONDC — V1 stub: credentials/toggle can be saved; push is not implemented yet.
 */

async function testConnection() {
  return {
    ok: false,
    error: 'ONDC push is coming soon — toggle saved for preference only',
  };
}

async function pushOrder() {
  throw new Error('ONDC order push is not implemented yet');
}

module.exports = { testConnection, pushOrder };
