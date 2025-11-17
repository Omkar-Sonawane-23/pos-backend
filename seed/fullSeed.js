// seed/fullSeed.js
require('dotenv').config();
const db = require('../db'); // expects db/index.js from earlier
const bcrypt = require('bcrypt');

const {
  Role,
  User,
  Restaurant,
  Outlet,
  Category,
  MenuItem,
  Supplier,
  InventoryItem,
  StockMovement
} = require('../models');

const BCRYPT_SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);

async function upsertRole(name, opts = {}) {
  const existing = await Role.findOne({ name });
  if (existing) return existing;
  return Role.create({ name, ...opts });
}

async function upsertUser({ email, name, password, roles = [], restaurant }) {
  let user = await User.findOne({ email });
  if (user) return user;
  const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  user = await User.create({ email, name, passwordHash, roles, restaurant, isActive: true });
  return user;
}

async function main() {
  await db.connect();
  console.log('Connected to MongoDB');

  // 1) Roles
  const superRole = await upsertRole('SuperAdmin', { description: 'Full access', scope: 'global' });
  const adminRole = await upsertRole('Admin', { description: 'Restaurant admin', scope: 'restaurant' });
  const cashierRole = await upsertRole('Cashier', { description: 'Cashier - create orders & payments', scope: 'restaurant' });

  console.log('Roles seeded:', [superRole.name, adminRole.name, cashierRole.name]);

  // 2) SuperAdmin user
  const superUser = await upsertUser({
    email: process.env.SUPERADMIN_EMAIL || 'superadmin@pos.com',
    name: process.env.SUPERADMIN_NAME || 'Super Admin',
    password: process.env.SUPERADMIN_PASSWORD || 'superadmin',
    roles: [superRole._id]
  });
  console.log('SuperAdmin:', superUser.email);

  // 3) Sample Restaurant + Outlet
  let restaurant = await Restaurant.findOne({ name: 'Sample Bistro' });
  if (!restaurant) {
    restaurant = await Restaurant.create({
      name: 'Sample Bistro',
      legalName: 'Sample Bistro Pvt Ltd',
      contactEmail: 'info@samplebistro.local',
      contactPhone: '+911234567890',
      address: '1 pos Street',
      cuisine: ['International']
    });
  }
  let outlet = await Outlet.findOne({ name: 'Main Outlet', address: '1 pos Street' });
  if (!outlet) {
    outlet = await Outlet.create({
      name: 'Main Outlet',
      code: 'MAIN',
      address: '1 pos Street',
      phone: '+911234567890',
      timeZone: 'Asia/Kolkata',
      currency: 'INR'
    });
    // attach outlet to restaurant
    restaurant.outlets = restaurant.outlets || [];
    if (!restaurant.outlets.find(id => id.equals(outlet._id))) {
      restaurant.outlets.push(outlet._id);
      await restaurant.save();
    }
  }
  console.log('Restaurant & Outlet:', restaurant.name, '/', outlet.name);

  // 4) Categories
  const catEntree = await Category.findOneAndUpdate(
    { restaurant: restaurant._id, name: 'Entrees' },
    { restaurant: restaurant._id, name: 'Entrees', order: 1 },
    { upsert: true, new: true }
  );
  const catDrinks = await Category.findOneAndUpdate(
    { restaurant: restaurant._id, name: 'Drinks' },
    { restaurant: restaurant._id, name: 'Drinks', order: 2 },
    { upsert: true, new: true }
  );
  console.log('Categories:', catEntree.name, ',', catDrinks.name);

  // 5) Inventory & Supplier
  const supplier = await Supplier.findOneAndUpdate(
    { name: 'Local Supplier' },
    { name: 'Local Supplier', phone: '+911111111111', email: 'supplier@pos.local' },
    { upsert: true, new: true }
  );

  const rice = await InventoryItem.findOneAndUpdate(
    { restaurant: restaurant._id, name: 'Rice (kg)' },
    {
      restaurant: restaurant._id,
      outlet: outlet._id,
      name: 'Rice (kg)',
      sku: 'INV-RICE-KG',
      unit: 'kg',
      costPrice: 40,
      currentQty: 50,
      parLevel: 10,
      supplier: supplier._id,
      isTracked: true
    },
    { upsert: true, new: true }
  );

  const chicken = await InventoryItem.findOneAndUpdate(
    { restaurant: restaurant._id, name: 'Chicken (kg)' },
    {
      restaurant: restaurant._id,
      outlet: outlet._id,
      name: 'Chicken (kg)',
      sku: 'INV-CHICK-KG',
      unit: 'kg',
      costPrice: 180,
      currentQty: 20,
      parLevel: 5,
      supplier: supplier._id,
      isTracked: true
    },
    { upsert: true, new: true }
  );

  const cola = await InventoryItem.findOneAndUpdate(
    { restaurant: restaurant._id, name: 'Canned Cola (pcs)' },
    {
      restaurant: restaurant._id,
      outlet: outlet._id,
      name: 'Canned Cola (pcs)',
      sku: 'INV-COLA-PC',
      unit: 'pcs',
      costPrice: 30,
      currentQty: 100,
      parLevel: 20,
      supplier: supplier._id,
      isTracked: true
    },
    { upsert: true, new: true }
  );

  console.log('Inventory items:', rice.name, chicken.name, cola.name);

  // 6) Menu items (with meta.recipe linking to inventory items and qty consumed)
  const pulao = await MenuItem.findOneAndUpdate(
    { restaurant: restaurant._id, name: 'Chicken Pulao' },
    {
      restaurant: restaurant._id,
      categories: [catEntree._id],
      name: 'Chicken Pulao',
      description: 'Fragrant rice cooked with chicken and spices',
      basePrice: 250,
      sku: 'MI-CHPUL',
      isActive: true,
      variants: [],
      modifiers: [{ name: 'Extra Chicken', price: 80, isRequired: false }],
      prepTimeMins: 20,
      meta: {
        // simple recipe for testing: consumes 0.35 kg rice and 0.25 kg chicken per serving
        recipe: [
          { inventoryItemId: rice._id, qty: 0.35, unit: 'kg' },
          { inventoryItemId: chicken._id, qty: 0.25, unit: 'kg' }
        ]
      },
      outletAvailability: [{ outlet: outlet._id, isAvailable: true }]
    },
    { upsert: true, new: true }
  );

  const colaMenu = await MenuItem.findOneAndUpdate(
    { restaurant: restaurant._id, name: 'Canned Cola' },
    {
      restaurant: restaurant._id,
      categories: [catDrinks._id],
      name: 'Canned Cola',
      description: 'Chilled canned cola',
      basePrice: 70,
      sku: 'MI-COLA',
      isActive: true,
      variants: [],
      modifiers: [{ name: 'Ice', price: 0 }],
      prepTimeMins: 2,
      meta: {
        recipe: [{ inventoryItemId: cola._id, qty: 1, unit: 'pcs' }]
      },
      outletAvailability: [{ outlet: outlet._id, isAvailable: true }]
    },
    { upsert: true, new: true }
  );

  console.log('Menu items:', pulao.name, ',', colaMenu.name);

  // 7) Create a test cashier user
  const cashierUser = await upsertUser({
    email: process.env.CASHIER_EMAIL || 'cashier@pos.com',
    name: process.env.CASHIER_NAME || 'Test Cashier',
    password: process.env.CASHIER_PASSWORD || 'cashier123',
    roles: [cashierRole._id],
    restaurant: restaurant._id
  });
  console.log('Cashier user:', cashierUser.email);

  // 8) Optionally create initial stock movement entries for audit
  await StockMovement.create([
    {
      restaurant: restaurant._id,
      outlet: outlet._id,
      inventoryItem: rice._id,
      change: +50,
      type: 'purchase',
      reference: 'INIT-STOCK',
      note: 'Initial stock seed'
    },
    {
      restaurant: restaurant._id,
      outlet: outlet._id,
      inventoryItem: chicken._id,
      change: +20,
      type: 'purchase',
      reference: 'INIT-STOCK',
      note: 'Initial stock seed'
    },
    {
      restaurant: restaurant._id,
      outlet: outlet._id,
      inventoryItem: cola._id,
      change: +100,
      type: 'purchase',
      reference: 'INIT-STOCK',
      note: 'Initial stock seed'
    }
  ]);

  console.log('Seed complete — summary:');
  console.log({
    restaurant: restaurant.name,
    outlet: outlet.name,
    superAdmin: superUser.email,
    cashier: cashierUser.email,
    sampleMenu: [pulao.name, colaMenu.name]
  });

  process.exit(0);
}

main().catch(err => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
