let { MongoClient } = require("mongodb");

let client = new MongoClient(process.env.MONGO_URL);
client.connect();

let db = client.db("project123");
// Inside your mongo connection setup file:
let statusCollec = db.collection("status"); // name it anything you prefer


module.exports = {
  messageCollec: db.collection("messages"),
  photoCollec: db.collection("files"),
  statusCollec: db.collection("status")
};
