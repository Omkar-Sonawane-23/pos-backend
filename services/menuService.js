// services/menuService.js
const { MenuItem } = require('../models');
const redisCache = require('../lib/redisCache'); // optional; no-op if REDIS_URL not set

const DEFAULT_LIMIT = 100;
const DEFAULT_PAGE = 0;
const CACHE_TTL = 10; // seconds; menu changes can be pushed to invalidate caches when needed
const listCacheKey = (outletId, forPos, page, limit) => `menu:list:${String(outletId||'all')}:forPos=${forPos}:p=${page}:l=${limit}`;

function buildOutletQuery(outletId) {
  // Keep semantics unchanged but use $or more efficiently.
  // If outletId provided, match:
  //  - items without outletAvailability (global)
  //  - items with an element for this outlet that is available
  return outletId ? {
    $or: [
      { outletAvailability: { $exists: false } },
      { outletAvailability: { $size: 0 } },
      { 'outletAvailability.outlet': outletId }, // quick match by array field
      { outletAvailability: { $elemMatch: { outlet: outletId, isAvailable: true } } }
    ]
  } : {};
}

/**
 * list({ outletId, forPos, page, limit })
 * - read from secondaries if available
 * - lean + projection for POS payload
 * - caches short-term in redis to absorb bursts
 * - supports pagination
 */
exports.list = async ({ outletId, forPos = false, page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = {}) => {
  const p = Number(page) || DEFAULT_PAGE;
  const l = Math.min(Number(limit) || DEFAULT_LIMIT, 500); // hard cap to avoid huge responses

  const cacheKey = listCacheKey(outletId, !!forPos, p, l);
  const cached = await redisCache.get(cacheKey);
  if (cached) return cached;

  const baseQuery = { isActive: true };
  Object.assign(baseQuery, buildOutletQuery(outletId));

  // Projection: when forPos is true, return a slimmer payload for faster transfer
  // include category so we can populate it below
  const posProjection = {
    name: 1,
    basePrice: 1,
    sku: 1,
    isActive: 1,
    isTaxable: 1,
    image: 1,
    prepTimeMins: 1,
    variants: 1,
    modifiers: 1,
    tags: 1,
    meta: 1,
    categories: 1
  };
  const defaultProjection = { categories: 1 }; // ensure category is available for populate when requesting full doc

  const projection = forPos ? posProjection : defaultProjection;

  const cursor = MenuItem.find(baseQuery)
    .read('secondaryPreferred') // prefer secondaries for read scaling
    .lean()
    .select(projection)
    .populate({ path: 'categories', select: 'name' }) // include category doc (name) with each item
    .sort({ name: 1 })
    .skip(p * l)
    .limit(l)
    .maxTimeMS(2000);

  const items = await cursor.exec();

  // cache short-term; if menu updates are frequent, you should invalidate on write
  await redisCache.set(cacheKey, items, CACHE_TTL);
  return items;
};

/**
 * getById(id)
 * - uses read preference to offload reads and short-term cache
 */
exports.getById = async (id) => {
  const key = `menu:item:${id}`;
  const cached = await redisCache.get(key);
  if (cached) return cached;

  const q = MenuItem.findById(id)
    .read('secondaryPreferred')
    .lean()
    .maxTimeMS(1500);

  const doc = await q.exec();
  if (doc) {
    await redisCache.set(key, doc, 30); // cache single items a little longer
  }
  return doc;
};
