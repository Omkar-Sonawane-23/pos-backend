// controllers/authController.js
const authService = require('../services/authService');

exports.register = async (req, res, next) => {
  try {
    const payload = req.body;
    const { user, token } = await authService.register(payload);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { user, token } = await authService.login(email, password);
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
};
