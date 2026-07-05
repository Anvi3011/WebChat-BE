require("dotenv").config();

let express = require("express");
let cors = require("cors");
let http = require("http");
let { Server } = require("socket.io");
let { ObjectId } = require("mongodb");

// ⭐ Added statusCollec here from your db config
let { messageCollec, photoCollec, statusCollec } = require("./config/db");
let { upload, cloudinary } = require("./config/cloudinary");

let app = express();
app.use(express.json());
app.use(cors({
  origin: ["https://webchat-9c8d4.web.app", "http://localhost:5173", "http://localhost:5174"],
  credentials: true
}));

app.post("/upload", upload.single("file"), (req, res) => {
  let obj = {
    username: req.body.username,
    caption: req.body.caption,
    file_url: req.file.path,
    file_name: req.file.filename
  };
  photoCollec.insertOne(obj)
  .then((result) => res.send(result))
  .catch((err) => res.send(err));
});

app.get("/files", (req, res) => {
  photoCollec.find().toArray()
  .then((result) => res.send(result))
  .catch((err) => res.send(err));
});

app.delete("/delete/:id", (req, res) => {
  let id = req.params.id;
  let _id = new ObjectId(id);
  photoCollec.findOne({ _id })
  .then((obj) => {
    cloudinary.uploader.destroy(obj.file_name);
    photoCollec.deleteOne({ _id });
  })
  .catch((err) => res.send(err));
});

let httpServer = http.createServer(app);

// ⭐ Configured dynamic CORS to explicitly allow all development origins/ports
// ⭐ Configured dynamic CORS to explicitly allow your production Firebase domain + local testing ports
let io = new Server(httpServer, { 
  cors: { 
    origin: (origin, callback) => {
      const allowedOrigins = [
        "https://webchat-9c8d4.web.app", // Added your production Firebase link
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174"
      ];
      if (!origin || allowedOrigins.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Blocked by CORS policy"));
      }
    },
    credentials: true
  } 
});

// Helper dictionary to map usernames to active socket IDs in memory for WebRTC signaling
let activeSockets = {};

io.on("connection", async (socket) => {
  console.log("Connected:", socket.id);

  let username = socket.handshake.query.username;

  // ⭐ Sync: Immediately send chat logs from MongoDB to the connecting user
  if (messageCollec) {
    messageCollec.find().toArray()
      .then((result) => socket.emit("history", result))
      .catch((err) => console.error("Error sending initial history:", err));
  }

  if (username) {
    activeSockets[username] = socket.id;

    // ⭐ Pure MongoDB: Update or Insert user online status
    if (statusCollec) {
      try {
        await statusCollec.updateOne(
          { username: username },
          { $set: { status: "online", socketId: socket.id, lastSeen: new Date() } },
          { upsert: true }
        );

        // Fetch absolute latest roster and broadcast to ALL active socket channels
        let allStatuses = await statusCollec.find().toArray();
        io.emit("user_statuses", allStatuses);

        // Also broadcast user_status_change detailing the status
        io.emit("user_status_change", { username, status: "online", lastSeen: new Date() });
      } catch (err) {
        console.error("Error setting user status or broadcasting:", err);
      }
    }
  }

  socket.on("getHistory", () => {
    messageCollec.find().toArray()
    .then((result) => socket.emit("history", result))
    .catch((err) => console.log(err));
  });

  socket.on("message", (data) => {
    messageCollec.insertOne(data);
    io.emit("message", data);
  });

  socket.on("typing_state", (data) => {
    socket.broadcast.emit("display_typing", { username, isTyping: data.isTyping });
  });

  // --- WEBRTC SIGNALING HANDLERS ---
  socket.on("call_user", ({ to, offer }) => {
    const targetSocketId = activeSockets[to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("incoming_call", { from: username, offer });
    }
  });

  socket.on("answer_call", ({ to, answer }) => {
    const targetSocketId = activeSockets[to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("call_accepted", { answer });
    }
  });

  socket.on("ice_candidate", ({ to, candidate }) => {
    const targetSocketId = activeSockets[to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("ice_candidate", { candidate });
    }
  });

  socket.on("end_call", ({ to }) => {
    const targetSocketId = activeSockets[to];
    if (targetSocketId) {
      io.to(targetSocketId).emit("call_ended");
    }
  });

  // --- DISCONNECT HANDLING ---
  socket.on("disconnect", async () => {
    console.log("Disconnected:", socket.id);

    if (username) {
      let rightNow = new Date().toISOString();
      delete activeSockets[username];

      // ⭐ Pure MongoDB: Mark user offline on disconnect and broadcast roster
      if (statusCollec) {
        try {
          await statusCollec.updateOne(
            { username: username },
            { $set: { status: "offline", lastSeen: rightNow } }
          );

          // Fetch absolute latest roster and broadcast to ALL active socket channels
          let allStatuses = await statusCollec.find().toArray();
          io.emit("user_statuses", allStatuses);

          // Also broadcast user_status_change
          io.emit("user_status_change", { username, status: "offline", lastSeen: rightNow });
        } catch (err) {
          console.error("Error setting offline status or broadcasting:", err);
        }
      }
    }
  });
});

httpServer.listen(3000, () => console.log("Server is alive at 3000"));