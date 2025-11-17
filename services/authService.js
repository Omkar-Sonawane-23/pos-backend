// services/authService.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { User, Role } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET || 'replace_this_secret_in_prod';
const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);

function signToken(user) {
  const payload = { sub: user._id.toString() , roles: user.roles };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

exports.register = async ({ email, name, password, roleName, restaurantId }) => {
  if (!email || !name || !password) throw Object.assign(new Error('Missing fields'), { status: 400 });
  const existing = await User.findOne({ email });
  if (existing) throw Object.assign(new Error('Email already exists'), { status: 400 });

  const passHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  const role = roleName ? await Role.findOne({ name: roleName }) : null;

  const user = await User.create({
    email,
    name,
    passwordHash: passHash,
    roles: role ? [role._id] : [],
    restaurant: restaurantId
  });

  const token = signToken(user);
  return { user: { id: user._id, email: user.email, name: user.name }, token };
};

exports.login = async (email, password) => {
  if (!email || !password) throw Object.assign(new Error('Missing credentials'), { status: 400 });
  const user = await User.findOne({ email }).populate('roles outlet restaurant');
  if (!user) throw Object.assign(new Error('User not found '), { status: 400 });

  const ok = await bcrypt.compare(password, user.passwordHash || '');
  if (!ok) throw Object.assign(new Error('Invalid credentials'), { status: 400 });
 
  const token = signToken(user);
  return { user: { id: user._id, email: user.email, name: user.name, outlet: user.outlet, restaurant: user.restaurant, roles: user.roles }, token };
};
