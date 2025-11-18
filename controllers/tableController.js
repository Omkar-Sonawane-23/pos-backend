// controllers/tableController.js
const tableService = require('../services/tableService');

exports.listTables = async (req, res, next) => {
    try {
        const outletId = req.query.outlet_id || (req.auth && req.auth.outletId);
        if (!outletId) return res.status(400).json({ error: 'outlet_id required' });
        const tables = await tableService.listTables(outletId);
        res.json({ data: tables });
    } catch (err) {
        next(err);
    }
};


exports.occupyTable = async (req, res, next) => {
    try {
        const tableId = req.params.id;
        const userId = req.auth && req.auth.sub;
        const occupied = await tableService.occupyTable(tableId, userId);
        res.json({ data: occupied });
    } catch (err) {
        next(err);
    }
};


exports.freeTable = async (req, res, next) => {
    try {
        const tableId = req.params.id;
        const userId = req.auth && req.auth.sub;
        const freed = await tableService.freeTable(tableId, userId);
        res.json({ data: freed });
    } catch (err) {
        next(err);
    }
};


exports.mergeTables = async (req, res, next) => {
    try {
        const { primaryTableId, secondaryTableId } = req.body;
        const userId = req.auth && req.auth.sub;
        const merged = await tableService.mergeTables(primaryTableId, secondaryTableId, userId);
        res.json({ data: merged });
    } catch (err) {
        next(err);
    }
};


exports.splitTable = async (req, res, next) => {
    try {
        const { tableId } = req.body;
        const userId = req.auth && req.auth.sub;
        const split = await tableService.splitTable(tableId, userId);
        res.json({ data: split });
    } catch (err) {
        next(err);
    }
};
