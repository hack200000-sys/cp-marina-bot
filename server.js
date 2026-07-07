\/**
 * Crowne Plaza Dubai Marina — WhatsApp Guest Complaint Bot
 * PRODUCTION build for Railway (Gemini + persistent JSON store)
 */
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  GEMINI_API_KEY,
  REVIEW_LINK = "https://g.page/r/YOUR-GOOGLE-REVIEW-LINK",
  STAFF_WA,
  HOTEL_NAME = "Crowne Plaza Dubai Marina",
  PORT = 8080,   // Railway default is 8080
} = process.env;

const GRAPH = "https://graph.facebook.com/v21.0";
const GEMINI_MODEL = "gemini-1.5-flash";

// Persistent store
const DB_FILE = process.env.DB_PATH || path.join(__dirname, "guests.json");
let guests = {};
try {
  guests = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} catch (e) {
  guests = {};
}

function save() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(guests)); }
  catch (e) { console.error("save error:", e.message); }
}

const VALID_ROOMS = [];
function isValidRoom(room) {
  if (!/^\d{3,4}$/.test(room)) return false;
  if (VALID_ROOMS.length === 0) return true;
  return VALID_ROOMS.includes(room);
}

async function sendText(to, body) {
  await axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}

// ──────────────────────────────────────────────
// WEBHOOK VERIFICATION (GET) - ROOT PATH
// ──────────────────────────────────────────────
app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook VERIFIED successfully!");
    return res.status(200).send(challenge);
  }

  res.send(`${HOTEL_NAME} bot is running (production).`);
});

// ──────────────────────────────────────────────
// INCOMING MESSAGES (POST)
// ──────────────────────────────────────────────
app.post("/", async (req, res) => {   // Changed to root to match Callback URL
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg || msg.type !== "text") return;

    const from = msg.from;
    const body = msg.text.body.trim();
    const name = entry.contacts?.[0]?.profile?.name;

    let guest = guests[from];
    if (!guest) {
      guests[from] = { room: null, stage: "awaiting_room", lastIssue: null };
      save();
      await sendText(from, `Hi 👋 Welcome to ${HOTEL_NAME}. I'm your virtual assistant. To get started, could you share your *room number*?`);
      return;
    }

    // ... (rest of your logic stays the same)
    if (guest.stage === "awaiting_room") {
      const room = body.replace(/\D/g, "");
      if (!isValidRoom(room)) {
        await sendText(from, "Hmm, I couldn't find that room number. Could you double-check and send it again? (It's usually 3–4 digits, e.g. 1204.)");
        return;
      }
      guest.room = room; 
      guest.stage = "active"; 
      save();
      await sendText(from, `Thank you! You're all set for room ${room}. How can I help?`);
      return;
    }

    // ... keep the rest of your classifyAndReply, notifyStaff, etc.

    const result = await classifyAndReply(guest.room, body);
    await sendText(from, result.reply);

    if (result.escalate) {
      guest.lastIssue = body; 
      guest.stage = "awaiting_rating"; 
      save();
      await notifyStaff(name, guest.room, body);
      setTimeout(() => {
        sendText(from, `Just so I can close this out — how would you rate how we handled it? Reply 1–5 ⭐`).catch(() => {});
      }, 1500);
    }
  } catch (err) {
    console.error("Handler error:", err.message);
  }
});

// Keep your helper functions (classifyAndReply, notifyStaff) below
async function classifyAndReply(room, message) {
  // ... (your existing function - unchanged)
  const prompt = `You are the guest-service assistant for ${HOTEL_NAME}.
A guest in room ${room} sent this message: "${message}"
...`;  // keep your full prompt
  // ... rest of classifyAndReply unchanged
}

async function notifyStaff(guestName, room, issue) {
  // ... unchanged
}

// Start server
app.listen(PORT, () => console.log(`${HOTEL_NAME} bot listening on :${PORT}`));
