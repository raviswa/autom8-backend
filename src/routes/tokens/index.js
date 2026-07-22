'use strict';

const express = require('express');
const router  = express.Router();

router.use(require('./create-and-alerts'));
router.use(require('./queries'));
router.use(require('./lifecycle'));

module.exports = router;
