// src/middleware/region.js
// Attaches region config to every request so routes can read
// req.region.currency, req.region.timezone, etc. without importing
// regionConfig directly.

const regionConfig = require('../config/regionConfig');

module.exports = function regionMiddleware(req, _res, next) {
  req.region = regionConfig;
  next();
};
