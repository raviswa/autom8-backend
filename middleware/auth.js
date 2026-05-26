// src/middleware/auth.js
// Extracted from server.js — authenticateToken + getRestaurantId

const { supabase, supabaseAdmin } = require('../config/supabase');

const authenticateToken = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = { sub: user.id, email: user.email };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Authentication failed' });
  }
};

const getRestaurantId = async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users').select('restaurant_id, role').eq('id', req.user.sub).single();

    if (error) return res.status(401).json({ error: `User lookup failed: ${error.message}` });
    if (!data)  return res.status(401).json({ error: 'User profile not found.' });

    if (!data.restaurant_id) {
      const { data: restaurants } = await supabaseAdmin.from('restaurants').select('id').limit(2);
      if (restaurants?.length === 1) {
        req.restaurant_id = restaurants[0].id;
        req.user_role     = data.role;
        return next();
      }
      return res.status(401).json({ error: 'User has no restaurant_id assigned.' });
    }

    req.restaurant_id = data.restaurant_id;
    req.user_role     = data.role;
    next();
  } catch (err) {
    res.status(401).json({ error: `Auth middleware failed: ${err.message}` });
  }
};

module.exports = { authenticateToken, getRestaurantId };
