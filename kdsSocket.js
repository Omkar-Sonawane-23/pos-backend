// kdsSocket.js
const { Server } = require('socket.io');
const OrderService = require('./services/orderService');

let ioInstance = null;

/**
 * Initialize Socket.IO + KDS namespace
 * @param {http.Server} httpServer
 */
function initKdsSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.KDS_CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
    },
  });

  ioInstance = io;

  // Namespace for KDS screens
  const kds = io.of('/kds');

  kds.on('connection', async (socket) => {
    try {
      const { restaurantId, outletId } = socket.handshake.query || {};

      if (!restaurantId) {
        socket.emit('error', { message: 'restaurantId is required in query' });
        socket.disconnect(true);
        return;
      }

      const room = makeRoom(restaurantId, outletId);
      socket.join(room);
      console.log(`[KDS] client connected ${socket.id} room=${room}`);

      // Send initial list of recent/open orders for this outlet
      try {
        const orders = await OrderService.listOrders({
          restaurant: restaurantId,
          outlet: outletId,
          limit: 100,
          page: 0,
        });

        socket.emit('orders:init', { orders });
      } catch (err) {
        console.error('[KDS] failed to load initial orders', err);
        socket.emit('orders:init:error', {
          message: 'Failed to load initial orders',
        });
      }

      /**
       * KDS wants to change order status (e.g. pending -> in_kitchen -> served)
       * payload: { orderId, status, userId }
       */
      socket.on('order:setStatus', async (payload) => {
        const { orderId, status, userId } = payload || {};
        if (!orderId || !status) {
          socket.emit('order:error', {
            orderId,
            message: 'orderId and status are required',
          });
          return;
        }

        try {
          const updated = await OrderService.updateOrderStatus(
            orderId,
            status,
            userId || null
          );

          if (!updated) {
            socket.emit('order:error', {
              orderId,
              message: 'Order not found after update',
            });
            return;
          }

          // Broadcast to all KDS clients for that restaurant/outlet
          emitOrderToKds(updated, 'order:statusUpdated');
        } catch (err) {
          console.error('[KDS] order:setStatus error', err);
          socket.emit('order:error', {
            orderId,
            message: err.message || 'Failed to update status',
          });
        }
      });

      socket.on('disconnect', (reason) => {
        console.log(`[KDS] client disconnected ${socket.id} reason=${reason}`);
      });
    } catch (err) {
      console.error('[KDS] connection handler error', err);
      try {
        socket.emit('error', { message: 'Internal KDS error' });
      } catch (_) {}
      socket.disconnect(true);
    }
  });

  return io;
}

/**
 * Build room key per restaurant/outlet
 */
function makeRoom(restaurantId, outletId) {
  const r = String(restaurantId);
  const o = outletId ? String(outletId) : 'all';
  return `kds:${r}:${o}`;
}

/**
 * Emit an order event to relevant KDS room(s)
 * event: 'order:created', 'order:statusUpdated', 'order:itemsUpdated', etc.
 */
function emitOrderToKds(order, event) {
  if (!ioInstance || !order) return;

  const kds = ioInstance.of('/kds');

  const restaurantId = order.restaurant;
  const outletId = order.outlet || 'all';

  const room = makeRoom(restaurantId, outletId);
  kds.to(room).emit(event, { order });
}

module.exports = {
  initKdsSocket,
  emitOrderToKds,
};
