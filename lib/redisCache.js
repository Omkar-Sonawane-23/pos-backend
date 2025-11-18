// lib/redisCache.js
const IORedis = (() => {
  try { return require('ioredis'); } catch (e) { return null; }
})();

let client = null;
if (process.env.REDIS_URL && IORedis) {
  client = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // tune pool/connection settings in prod
  });

  client.on('error', (err) => {
    // don't crash the app on transient redis failures
    console.error('Redis error', err && err.message ? err.message : err);
  });
}

module.exports = {
  client,
  async get(key) {
    if (!client) return null;
    try {
      const val = await client.get(key);
      return val ? JSON.parse(val) : null;
    } catch (e) { return null; }
  },
  async set(key, value, ttlSeconds = 5) { // default short TTL
    if (!client) return;
    try {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (e) { /*noop*/ }
  },
  async del(key) {
    if (!client) return;
    try { await client.del(key); } catch (e) { /*noop*/ }
  }
};
