// db/index.js
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/pos';

module.exports = {
  connect: async () => {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    // optional: expose mongoose for transactions
    return mongoose;
  },
  mongoose
};
