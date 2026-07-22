'use strict';

const express = require('express');
const router  = express.Router();

router.use(require('./menu-items'));
router.use(require('./orders'));
router.use(require('./kds'));
router.use(require('./tables'));
router.use(require('./restaurants'));
router.use(require('./payments'));
router.use(require('./reports'));

module.exports = router;
