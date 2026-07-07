/**
 * Crowne Plaza Dubai Marina — WhatsApp Guest Complaint Bot
 * PRODUCTION build for Railway (Gemini + persistent JSON store)
 *
 * Config comes from environment variables (set in Railway dashboard).
 * Guest state persists to a JSON file so restarts don't lose data.
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
  PORT = 3000,
} = process.env;

const GRAPH = "https://graph.facebook.com/v21.0";
const GEMINI_MODEL = "gemini-1.5-flash";

// --- Persistent store: simple JSON file (survives restarts) ---
const DB_FILE = process.env.DB_PATH || path.join(__dirname, "guests.json");
let guests = {};
try { guests = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { guests = {}; }
function save() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(guests)); }
  catch (e) { console.error("save error:", e.message); }
}

const VALID_ROOMS = []; // empty = accept any 3-4 digit; fill from PMS to validate
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

async function classifyAndReply(room, message) {
  const prompt = `You are the guest-service assistant for ${HOTEL_NAME}.
A guest in room ${room} sent this message: "${message}"
Do two things:
1. Classify it as one of: "complaint", "question", "request".
2. Write a warm, concise reply (2-3 sentences max).
If it is a complaint that needs staff (maintenance, cleanliness, noise, billing, safety,
anything you cannot resolve with information alone), set "escalate" to true.
Simple questions and info requests set "escalate" to false.
Respond ONLY with JSON, no markdown, exactly:
{"category":"...","reply":"...","escalate":true}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
  });
  let text = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  text = text.replace(/\`\`\`json|\`\`\`/g, "").trim();
  try { return JSON.parse(text); }
  catch {
    return { category: "request",
      reply: "Thanks for your message — I've passed this to our team who will follow up shortly.",
      escalate: true };
  }
}

async function notifyStaff(guestName, room, issue) {
  if (!STAFF_WA) return;
  await sendText(STAFF_WA,
    `⚠️ Complaint — ${HOTEL_NAME}\nGuest: ${guestName || "Guest"}\nRoom: ${room}\nIssue: ${issue}\nNeeds follow-up.`);
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
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
      guests[from] = { room: null, stage: "awaiting_room", lastIssue: null }; save();
      await sendText(from, `Hi 👋 Welcome to ${HOTEL_NAME}. I'm your virtual assistant, here to help with any request or issue during your stay. To get started, could you share your *room number*?`);
      return;
    }
    if (guest.stage === "awaiting_room") {
      const room = body.replace(/\D/g, "");
      if (!isValidRoom(room)) {
        await sendText(from, "Hmm, I couldn't find that room number. Could you double-check and send it again? (It's usually 3–4 digits, e.g. 1204.)");
        return;
      }
      guest.room = room; guest.stage = "active"; save();
      await sendText(from, `Thank you! You're all set for room ${room}. How can I help — is there anything you need or any issue I can sort out for you?`);
      return;
    }
    if (guest.stage === "awaiting_rating") {
      const rating = parseInt(body.replace(/\D/g, ""), 10);
      guest.stage = "active"; save();
      if (rating >= 4) {
        await sendText(from, `Thank you, ${name || "so much"}! 🙏 We'd love a quick review of your stay at ${HOTEL_NAME} — it takes 30 seconds and really helps us: ${REVIEW_LINK}`);
      } else {
        await sendText(from, "I'm sorry we didn't get this fully right. I've flagged it to our manager, who will personally follow up with you shortly.");
        await notifyStaff(name, guest.room, `LOW RATING (${rating || "?"}) on: ${guest.lastIssue}`);
      }
      return;
    }
    const result = await classifyAndReply(guest.room, body);
    await sendText(from, result.reply);
    if (result.escalate) {
      guest.lastIssue = body; guest.stage = "awaiting_rating"; save();
      await notifyStaff(name, guest.room, body);
      setTimeout(() => {
        sendText(from, `Just so I can close this out — how would you rate how we handled it? Reply 1–5 ⭐ (5 = excellent).`).catch(() => {});
      }, 1500);
    }
  } catch (err) {
    console.error("Handler error:", err.response?.data || err.message);
  }
});

app.get("/", (_req, res) => res.send(`${HOTEL_NAME} bot is running (production).`));
app.listen(PORT, () => console.log(`${HOTEL_NAME} bot listening on :${PORT}`));
