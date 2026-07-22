'use strict';

const express = require('express');
const router  = express.Router();

router.use(require('./session'));
router.use(require('./checkout'));
router.use(require('./delivery'));
router.use(require('./webhooks'));
router.use(require('./pages'));

module.exports = router;
