// Tests run against a real MongoDB started just for the test (downloaded once, then cached), never your Atlas data.
const { MongoMemoryServer } = require('mongodb-memory-server');

async function startMongo() {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = 'menucard_test';
  return mongo;
}
module.exports = { startMongo };
