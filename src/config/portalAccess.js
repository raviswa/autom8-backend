// src/config/portalAccess.js
// Allowed portal / access_level values for employee_portal_access (app-layer).

'use strict';

const PORTALS = [
  'manager_portal',
  'fulfillment',
  'captain',
  'marketing',
  'owner_dashboard',
];

const ACCESS_LEVELS = [
  'owner',
  'editor',
  'viewer',
  'fulfillment',
  'captain',
];

const LEVEL_RANK = {
  viewer: 1,
  editor: 2,
  owner: 3,
  fulfillment: 2,
  captain: 2,
};

function isValidPortal(portal) {
  return PORTALS.includes(String(portal || ''));
}

function isValidAccessLevel(level) {
  return ACCESS_LEVELS.includes(String(level || ''));
}

module.exports = {
  PORTALS,
  ACCESS_LEVELS,
  LEVEL_RANK,
  isValidPortal,
  isValidAccessLevel,
};
