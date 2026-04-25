require("dotenv").config();

const express = require("express");
const path = require("path");
const cors = require("cors");
const multer = require("multer");
const bcrypt = require("bcrypt");
const session = require("express-session");
const OpenAI = require("openai");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const mongoose = require("mongoose");

const app = express();

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error(err));

const Conversation = mongoose.model("Conversation", {
  companyId: String,
  conversationId: String,
  message: String,
  reply: String,
  email: String,
  time: String
});

const CompanyData = mongoose.model("CompanyData", {
  companyId: String,
  knowledge: String
});

const AIFix = mongoose.model("AIFix", {
  companyId: String,
  original: String,
  improved: String
});

const Lead = mongoose.model("Lead", {
  companyId: String,
  name: String,
  email: String,
  time: String
});

const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: "assistly-secret-key-change-this",
    resave: false,
    saveUninitialized: false
  })
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function getAIFixes(companyId) {
  return await AIFix.find({ companyId });
}

async function saveAIFix(companyId, original, improved) {
  await AIFix.findOneAndUpdate(
    { companyId, original },
    { improved },
    { upsert: true }
  );
}

function slugifyCompanyName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}


app.post("/signup", async (req, res) => {
  const { companyName, password } = req.body;

  if (!companyName || !password) {
    return res.status(400).json({ message: "Company name and password are required" });
  }

  const companyId = slugifyCompanyName(companyName);

  const existing = await CompanyData.findOne({ companyId });

  if (existing) {
    return res.status(400).json({ message: "Company already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await CompanyData.create({
    companyId,
    knowledge: ""
  });

  await mongoose.connection.collection("companies").insertOne({
    companyId,
    companyName,
    passwordHash,
    createdAt: new Date().toISOString()
  });

  res.json({ success: true, companyId, companyName });
});

app.post("/login", async (req, res) => {
  const { companyName, password } = req.body;

  if (!companyName || !password) {
    return res.status(400).json({ message: "Company name and password are required" });
  }

  const companyId = companyName.trim().toLowerCase().replace(/\s+/g, "-");

  const company = await mongoose.connection
    .collection("companies")
    .findOne({ companyId });

  if (!company) {
    return res.status(401).json({ message: "Invalid login" });
  }

  const passwordOk = await bcrypt.compare(password, company.passwordHash);

  if (!passwordOk) {
    return res.status(401).json({ message: "Invalid login" });
  }

  req.session.companyId = company.companyId;

  res.json({
    success: true,
    companyId: company.companyId,
    companyName: company.companyName
  });
});

app.post("/chat", async (req, res) => {
  const { message, companyId, conversationId } = req.body;

  if (!message || !companyId) {
    return res.status(400).json({ message: "Missing message or companyId" });
  }

  const companyDoc = await CompanyData.findOne({ companyId });
const companyData = companyDoc ? companyDoc.knowledge : "";
const fixes = await getAIFixes(companyId);

const normalize = (text) =>
  text.toLowerCase().replace(/[^\w\s]/gi, "").trim();

const normalizedMessage = normalize(message);

const foundFix = fixes.find(f =>
  normalize(message).includes(normalize(f.original)) ||
  normalize(f.original).includes(normalize(message))
);

  const emailMatch = message.match(/[^\s]+@[^\s]+\.[^\s]+/);

  let name = "Unknown";
  const nameMatch = message.match(/(?:my name is|i am|this is)\s+([a-zA-Z]+)/i);

  if (nameMatch) {
    name = nameMatch[1];
  } else if (emailMatch) {
    name = message.trim().split(/\s+/)[0];
  }

if (foundFix) {
  return res.json({
    reply: foundFix.improved,
    conversationId: conversationId || Date.now().toString()
  });
}

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are an AI assistant for a specific company.

You MUST ONLY answer questions related to the company, its services, pricing, or support.

If the question is NOT related to the company, respond with:
"I'm here to help with questions about our company and services."

Here is information about the company:
${companyData || "No company data yet"}

Rules:
- Only answer using the company information
- Do NOT answer general knowledge questions
- Keep answers short and professional
- If the user shows buying interest, ask for name and email
- If the user already provided email, do not ask again
`
        },
        {
          role: "user",
          content: `
User message: ${message}

User info:
Name: ${name}
Email: ${emailMatch ? emailMatch[0] : "not provided"}
`
        }
      ]
    });

    const answer = response.choices[0].message.content;

    const finalConversationId = conversationId || Date.now().toString();

await Conversation.create({
  companyId,
  conversationId: finalConversationId,
  message,
  reply: answer,
  email: emailMatch ? emailMatch[0].toLowerCase() : null,
  time: new Date().toISOString()
});


      if (emailMatch) {
  const existingLead = await Lead.findOne({
    companyId,
    email: emailMatch[0].toLowerCase()
  });

  if (!existingLead) {
    await Lead.create({
      companyId,
      name,
      email: emailMatch[0].toLowerCase(),
      time: new Date().toISOString()
    });
  }
}
    

    res.json({
      reply: answer,
      conversationId: finalConversationId
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error generating reply" });
  }
});

app.get("/conversations", async (req, res) => {
  const { companyId } = req.query;

  if (!companyId) {
    return res.status(400).json({ message: "companyId is required" });
  }

  const allMessages = await Conversation.find({ companyId }).sort({ time: 1 });

const grouped = {};

allMessages.forEach(msg => {
  if (!grouped[msg.conversationId]) {
    grouped[msg.conversationId] = [];
  }
  grouped[msg.conversationId].push(msg);
});

const result = Object.keys(grouped).map(id => {
  const messages = grouped[id];
  const last = messages[messages.length - 1];

  return {
    conversationId: id,
    email: last.email || "Unknown contact",
    message: last.message || ""
  };
}).sort((a, b) => Number(b.conversationId) - Number(a.conversationId));

res.json(result);
});

app.get("/conversation-messages", async (req, res) => {
  const { companyId, conversationId } = req.query;

  if (!companyId || !conversationId) {
    return res.status(400).json({ message: "companyId and conversationId are required" });
  }

  const messages = await Conversation.find({
  companyId,
  conversationId
}).sort({ time: 1 });

res.json(messages);
});

app.get("/lead-conversation", async (req, res) => {
  const { companyId, email } = req.query;

  if (!companyId || !email) {
    return res.status(400).json({ message: "companyId and email are required" });
  }

  const messages = await Conversation.find({
    companyId,
    email: email.toLowerCase()
  }).sort({ time: 1 });

  res.json(messages);
});

app.get("/leads", async (req, res) => {
  const { companyId } = req.query;

  if (!companyId) {
    return res.status(400).json({ message: "companyId is required" });
  }

  const leads = await Lead.find({ companyId }).sort({ time: -1 });

  res.json(leads);
});

app.delete("/delete-lead/:id", async (req, res) => {
  const { id } = req.params;
  const { companyId } = req.query;

  if (!companyId) {
    return res.status(400).json({ message: "companyId is required" });
  }

  await Lead.findByIdAndDelete(id);

  res.json({ success: true });
});

app.post("/upload-pdf", upload.single("pdf"), async (req, res) => {
  const companyId = req.body.companyId;

  if (!companyId) {
    return res.status(400).json({ message: "companyId is required" });
  }

  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }

  try {
    const filePath = req.file.path;
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    const text = pdfData.text || "";

    await CompanyData.findOneAndUpdate(
  { companyId },
  {
    $set: {
      knowledge: await (async () => {
        const existing = await CompanyData.findOne({ companyId });
        const old = existing?.knowledge || "";
        return `${old}\n\n${text}`.trim();
      })()
    }
  },
  { upsert: true }
);

    res.json({ message: "PDF uploaded and processed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error reading PDF" });
  }
});

app.post("/save-website", async (req, res) => {
  const { url, companyId } = req.body;

  if (!url || !companyId) {
    return res.status(400).json({ message: "Missing data" });
  }

  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    const text = $("body").text();

    await CompanyData.findOneAndUpdate(
      { companyId },
      { knowledge: text },
      { upsert: true }
    );

    res.json({ message: "Website saved successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching website" });
  }
});

app.post("/improve-ai", (req, res) => {
  console.log("IMPROVE AI HIT:", req.body);

  const { original, improved, companyId } = req.body;

  if (!original || !improved || !companyId) {
    return res.status(400).json({ message: "Missing data" });
  }

  saveAIFix(companyId, original, improved);

  res.json({ success: true });
});

app.get("/widget.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");

  res.send(`
(function () {
  const button = document.createElement("div");
  button.innerHTML = "💬";
  button.style.position = "fixed";
  button.style.bottom = "20px";
  button.style.right = "20px";
  button.style.width = "60px";
  button.style.height = "60px";
  button.style.background = "#4f46e5";
  button.style.color = "white";
  button.style.borderRadius = "50%";
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.fontSize = "24px";
  button.style.cursor = "pointer";
  button.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
  button.style.zIndex = "9999";

  const chatBox = document.createElement("div");
  chatBox.style.position = "fixed";
  chatBox.style.bottom = "90px";
  chatBox.style.right = "20px";
  chatBox.style.width = "300px";
  chatBox.style.height = "400px";
  chatBox.style.background = "white";
  chatBox.style.borderRadius = "12px";
  chatBox.style.boxShadow = "0 10px 30px rgba(0,0,0,0.2)";
  chatBox.style.display = "none";
  chatBox.style.flexDirection = "column";
  chatBox.style.overflow = "hidden";
  chatBox.style.zIndex = "9999";

 chatBox.innerHTML =
  '<div style="background:#4f46e5;color:white;padding:10px;font-weight:bold;">' +
  'Assistly</div>' +
  '<div id="assistly-messages" style="flex:1;overflow-y:auto;padding:10px;font-size:14px;"></div>' +
  '<input id="assistly-input" placeholder="Type a message..." ' +
  'style="border:none;border-top:1px solid #eee;padding:10px;outline:none;" />';

  button.onclick = () => {
    chatBox.style.display =
      chatBox.style.display === "none" ? "flex" : "none";
  };

const input = chatBox.querySelector("#assistly-input");

input.addEventListener("keypress", function (e) {
  if (e.key === "Enter") {
    const msg = input.value;
if (!msg) return;

// show user message
const message = document.createElement("div");
message.innerText = msg;
message.style.padding = "8px";
message.style.margin = "5px";
message.style.background = "#eee";
message.style.borderRadius = "8px";

const messagesDiv = chatBox.querySelector("#assistly-messages");
messagesDiv.appendChild(message);
messagesDiv.scrollTop = messagesDiv.scrollHeight;

input.value = "";

// send to backend
let companyId = "rockleadership-solutions"; // fallback

const scripts = document.getElementsByTagName("script");

for (let s of scripts) {
  if (s.src.includes("widget.js") && s.getAttribute("data-company")) {
    companyId = s.getAttribute("data-company");
  }
}

let conversationId = window.assistlyConversationId || null;

fetch("https://assistlychat.com/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
  message: msg,
  companyId: companyId,
  conversationId: conversationId
})
})
.then(res => res.json())
.then(data => {
if (data.conversationId) {
  window.assistlyConversationId = data.conversationId;
}
  const reply = document.createElement("div");
  reply.innerText = data.reply || data.message;
  reply.style.padding = "8px";
  reply.style.margin = "5px";
  reply.style.background = "#4f46e5";
  reply.style.color = "white";
  reply.style.borderRadius = "8px";

  const messagesDiv = chatBox.querySelector("#assistly-messages");
messagesDiv.appendChild(reply);
messagesDiv.scrollTop = messagesDiv.scrollHeight;
});

  }
});

  document.body.appendChild(button);
  document.body.appendChild(chatBox);
})();
`);
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});