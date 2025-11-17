// seed/seedRoles.js
const { Role, User } = require('../models');
const bcrypt = require('bcrypt');

const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);

module.exports = async function seed() {
  const defaults = [
    { name: 'SuperAdmin', description: 'Full access', scope: 'global' },
    { name: 'Admin', description: 'Restaurant admin', scope: 'restaurant' },
    { name: 'Cashier', description: 'Cashier - create orders & payments', scope: 'restaurant' }
  ];

  for (const d of defaults) {
    const exists = await Role.findOne({ name: d.name });
    if (!exists) await Role.create(d);
  }

  // create a superadmin user if none exists
  const superRole = await Role.findOne({ name: 'SuperAdmin' });
  const anySuper = await User.findOne({ roles: superRole._id });
  if (!anySuper) {
    const pass = process.env.SUPERADMIN_PASSWORD || 'superadmin';
    const passHash = await bcrypt.hash(pass, BCRYPT_SALT_ROUNDS);
    await User.create({
      email: process.env.SUPERADMIN_EMAIL || 'superadmin@example.com',
      name: process.env.SUPERADMIN_NAME || 'Super Admin',
      passwordHash: passHash,
      roles: [superRole._id],
      isActive: true
    });
    console.log('Seeded SuperAdmin account. Set env vars to change credentials.');
  }
};
