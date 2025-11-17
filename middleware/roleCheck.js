// middleware/roleCheck.js
const { User } = require('../models'); // assumes models/index.js exports User

// requiredRoles can be string or array
module.exports = (requiredRoles) => {
  if (!Array.isArray(requiredRoles)) requiredRoles = [requiredRoles];

  return async (req, res, next) => {
    try {
      const userId = req.auth && req.auth.sub;
      if (!userId) return res.status(403).json({ error: 'Forbidden' });
      const user = await User.findById(userId).populate('roles');
      if (!user) return res.status(403).json({ error: 'Forbidden' });

      const roleNames = (user.roles || []).map(r => r.name);
      const allowed = requiredRoles.some(rr => roleNames.includes(rr));
      if (!allowed) return res.status(403).json({ error: 'Insufficient role' });

      req.currentUser = user;
      next();
    } catch (err) {
      next(err);
    }
  };
};
