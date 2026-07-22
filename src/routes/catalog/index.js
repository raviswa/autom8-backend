// src/routes/catalog/index.js
// ============================================================================
// Catalog, menu, and slot management (split from catalog.js — behavior unchanged)
// ============================================================================

'use strict';

const express = require('express');
const router  = express.Router();

const slots = require('./shared/slots');
const feed = require('./feed');
const menuItems = require('./menu-items');

router.use(require('./sync'));
router.use(feed);
router.use(menuItems);
router.use(require('./categories'));

module.exports = router;
module.exports.getCurrentSlotIST = slots.getCurrentSlotIST;
module.exports.applySlotAvailability = slots.applySlotAvailability;
module.exports.handleInternalMenuItems = feed.handleInternalMenuItems;
module.exports.handleMenuUpload = menuItems.handleMenuUpload;
module.exports.menuUploadMiddleware = menuItems.menuUploadMiddleware;
module.exports.menuItemAvailabilityMiddleware = menuItems.menuItemAvailabilityMiddleware;
module.exports.menuItemSpecialTodayMiddleware = menuItems.menuItemSpecialTodayMiddleware;
module.exports.menuItemDiscountMiddleware = menuItems.menuItemDiscountMiddleware;
module.exports.resetDailySpecialDishes = menuItems.resetDailySpecialDishes;
module.exports.nextOpenSlotDescriptionIST = slots.nextOpenSlotDescriptionIST;
module.exports.currentSlotLabelIST = slots.currentSlotLabelIST;
module.exports.applySlotForAllRestaurants = slots.applySlotForAllRestaurants;
