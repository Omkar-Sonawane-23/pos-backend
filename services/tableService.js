const { mongoose } = require('../db').mongoose || require('mongoose');
const { Table, Order } = require('../models');


exports.listTables = async (outletId) => {
    return Table.find({ outlet: outletId }).lean().select('-meta').exec();
}

/**
* mergeTables(primaryTableId, secondaryTableId, userId)
* marks secondary as mergedInto primary. Primary's currentOrder remains authoritative.
*/
exports.mergeTables = async (primaryTableId, secondaryTableId, userId) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        if (primaryTableId === secondaryTableId) throw Object.assign(new Error('Same table'), { status: 400 });
        const [primary, secondary] = await Promise.all([
            Table.findById(primaryTableId).session(session),
            Table.findById(secondaryTableId).session(session)
        ]);
        if (!primary || !secondary) throw Object.assign(new Error('Table not found'), { status: 404 });


        // If both have orders, we require a merge strategy (reject here)
        if (primary.currentOrder && secondary.currentOrder) {
            throw Object.assign(new Error('Both tables have active orders. Merge by manual reconciliation.'), { status: 409 });
        }


        // mark secondary as merged
        secondary.mergedInto = primary._id;
        secondary.status = 'occupied';
        // if primary has currentOrder, keep it; otherwise move secondary order to primary
        if (!primary.currentOrder && secondary.currentOrder) {
            primary.currentOrder = secondary.currentOrder;
            primary.status = 'occupied';
            secondary.currentOrder = null;
        } else {
            primary.status = 'occupied';
        }


        await primary.save({ session });
        await secondary.save({ session });


        await session.commitTransaction();
        session.endSession();
        return { primary, secondary };
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err;
    }
};


/**
* splitTable(tableId, userId)
* un-merges the table (clear mergedInto and set status available)
*/
exports.splitTable = async (tableId, userId) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const table = await Table.findById(tableId).session(session);
        if (!table) throw Object.assign(new Error('Table not found'), { status: 404 });


        table.mergedInto = null;
        if (!table.currentOrder) table.status = 'available';
        await table.save({ session });


        await session.commitTransaction();
        session.endSession();
        return table;
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err;
    }
};