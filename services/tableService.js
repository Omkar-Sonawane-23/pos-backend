// services/tableService.js
const { mongoose } = require('../db').mongoose || require('mongoose');
const { Table, Order } = require('../models');
const redisCache = require('../lib/redisCache'); // optional (no-op if redis disabled)
const crypto = require('crypto');

const CACHE_TTL = 5; // seconds - tiny for rapidly changing table state
const listCacheKey = (outletId) => `tables:list:${outletId}`;

/**
 * listTables(outletId)
 * - reads from secondaryPreferred where possible
 * - uses lean + projection to minimize payload
 * - caches results in redis briefly to absorb burst traffic
 */
exports.listTables = async (outletId) => {
    const key = listCacheKey(outletId);
    // Try cache
    const cached = await redisCache.get(key);
    if (cached) return cached;

    // Use read preference to offload reads to secondaries (eventual consistency ok)
    const query = Table.find({ outlet: outletId })
        .read('secondaryPreferred') // prefer secondaries
        .lean()
        .select('-meta -__v') // don't send meta or mongoose internal fields
        .maxTimeMS(2000) // protect against long-running queries
        .sort({ name: 1 });

    const tables = await query.exec();
    // write cache (short TTL)
    await redisCache.set(key, tables, CACHE_TTL);
    return tables;
};

/**
 * occupyTable(tableId, userId)
 * - atomic conditional update: only occupy if table is 'available' or 'reserved'
 * - avoids races using a single findOneAndUpdate
 */
exports.occupyTable = async (tableId, userId) => {
    // Only change from available/reserved -> occupied. Return the new document.
    const filter = { _id: tableId, status: { $in: ['available', 'reserved'] } };
    const update = {
        $set: { status: 'occupied' }
        // don't add new fields; if you want to set currentOrder do it in a separate API/mutation.
    };

    // Use findOneAndUpdate atomically and return the new doc. Use lean after to get plain object.
    const updated = await Table.findOneAndUpdate(filter, update, {
        new: true,
        projection: '-meta -__v'
    }).exec();

    // Invalidate cache for outlet if changed
    if (updated && updated.outlet) {
        await redisCache.del(listCacheKey(String(updated.outlet)));
    }

    if (!updated) {
        // Either not found or already occupied — send 409-like behavior via thrown error
        const err = new Error('Table not available to occupy');
        err.status = 409;
        throw err;
    }

    return updated.toObject ? updated.toObject() : updated;
};

/**
 * freeTable(tableId, userId)
 * - atomic conditional update: only free if table is currently occupied or reserved
 * - frees currentOrder pointer if present (keeps invariant)
 */
exports.freeTable = async (tableId, userId) => {
    // We clear currentOrder (if any) and set status to available only if currently occupied/reserved.
    const filter = { _id: tableId, status: { $in: ['occupied', 'reserved'] } };
    const update = {
        $set: { status: 'available', currentOrder: null }
    };

    const updated = await Table.findOneAndUpdate(filter, update, {
        new: true,
        projection: '-meta -__v'
    }).exec();

    if (updated && updated.outlet) {
        await redisCache.del(listCacheKey(String(updated.outlet)));
    }

    if (!updated) {
        const err = new Error('Table not occupied or cannot be freed');
        err.status = 409;
        throw err;
    }

    return updated.toObject ? updated.toObject() : updated;
};

/**
 * mergeTables(primaryTableId, secondaryTableId, userId)
 * - uses a replica-set transaction via session.withTransaction
 * - minimal transaction body: loads only the necessary docs, performs checks and writes
 * - retries handled by withTransaction semantics
 */
exports.mergeTables = async (primaryTableId, secondaryTableId, userId) => {
    if (primaryTableId === secondaryTableId) {
        const e = new Error('Same table');
        e.status = 400;
        throw e;
    }

    const session = await mongoose.startSession();
    try {
        const result = await session.withTransaction(async () => {
            // Load both docs inside the transaction
            const [primary, secondary] = await Promise.all([
                Table.findById(primaryTableId).session(session).exec(),
                Table.findById(secondaryTableId).session(session).exec()
            ]);

            if (!primary || !secondary) {
                const e = new Error('Table not found');
                e.status = 404;
                throw e;
            }

            // If both have orders, reject to avoid automatic merge logic
            if (primary.currentOrder && secondary.currentOrder) {
                const e = new Error('Both tables have active orders. Merge by manual reconciliation.');
                e.status = 409;
                throw e;
            }

            // mark secondary as merged
            secondary.mergedInto = primary._id;
            secondary.status = 'occupied';

            // if primary has no order but secondary does, move it
            if (!primary.currentOrder && secondary.currentOrder) {
                primary.currentOrder = secondary.currentOrder;
                primary.status = 'occupied';
                secondary.currentOrder = null;
            } else {
                primary.status = 'occupied';
            }

            // Save minimal docs
            await Promise.all([
                primary.save({ session }),
                secondary.save({ session })
            ]);

            return { primary: primary.toObject ? primary.toObject() : primary, secondary: secondary.toObject ? secondary.toObject() : secondary };
        }, {
            readPreference: 'primary',
            // transaction options: adjust writeConcern / readConcern if needed for your cluster
            readConcern: { level: 'local' },
            writeConcern: { w: 'majority' }
        });

        // invalidate caches for impacted outlets
        if (result && result.primary && result.primary.outlet) {
            await redisCache.del(listCacheKey(String(result.primary.outlet)));
        }
        if (result && result.secondary && result.secondary.outlet) {
            await redisCache.del(listCacheKey(String(result.secondary.outlet)));
        }

        return result;
    } finally {
        session.endSession();
    }
};

/**
 * splitTable(tableId, userId)
 * - unmerge the table inside a transaction
 */
exports.splitTable = async (tableId, userId) => {
    const session = await mongoose.startSession();
    try {
        const result = await session.withTransaction(async () => {
            const table = await Table.findById(tableId).session(session).exec();
            if (!table) {
                const e = new Error('Table not found');
                e.status = 404;
                throw e;
            }

            table.mergedInto = null;
            if (!table.currentOrder) table.status = 'available';
            await table.save({ session });

            return table;
        }, {
            readPreference: 'primary',
            readConcern: { level: 'local' },
            writeConcern: { w: 'majority' }
        });

        if (result && result.outlet) {
            await redisCache.del(listCacheKey(String(result.outlet)));
        }

        return result.toObject ? result.toObject() : result;
    } finally {
        session.endSession();
    }
};
