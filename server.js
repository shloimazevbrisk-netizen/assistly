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

const app = express();
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

const DATA_DIR = __dirname;
const COMPANIES_FILE = path.join(DATA_DIR, "companies.json");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");
const COMPANY_DATA_FILE = path.join(DATA_DIR, "company-data.json");

const AI_FIXES_FILE = path.join(DATA_DIR, "ai-fixes.json");
ensureFile(AI_FIXES_FILE, []);

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

ensureFile(COMPANIES_FILE, []);
ensureFile(LEADS_FILE, []);
ensureFile(CONVERSATIONS_FILE, []);
ensureFile(COMPANY_DATA_FILE, {});

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getAIFixes(companyId) {
  const all = readJson(AI_FIXES_FILE, []);
  return all.filter(f => f.companyId === companyId);
}

function saveAIFix(companyId, original, improved) {
  const all = readJson(AI_FIXES_FILE, []);

  const existing = all.find(
    f => f.companyId === companyId && f.original === original
  );

  if (existing) {
    existing.improved = improved; // ✅ overwrite existing fix
  } else {
    all.push({
      id: Date.now().toString(),
      companyId,
      original,
      improved
    });
  }

  writeJson(AI_FIXES_FILE, all);
}

function slugifyCompanyName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function getCompanyKnowledge(companyId) {
  const allData = readJson(COMPANY_DATA_FILE, {});
  return allData[companyId] || "";
}

function saveCompanyKnowledge(companyId, text) {
  const allData = readJson(COMPANY_DATA_FILE, {});
  allData[companyId] = text;
  writeJson(COMPANY_DATA_FILE, allData);
}

app.post("/signup", async (req, res) => {
  const { companyName, password } = req.body;

  if (!companyName || !password) {
    return res.status(400).json({ message: "Company name and password are required" });
  }

  const companies = readJson(COMPANIES_FILE, []);
  const existing = companies.find(
    c => c.companyName.toLowerCase() === companyName.toLowerCase()
  );

  if (existing) {
    return res.status(400).json({ message: "Company already exists" });
  }

  const companyId = slugifyCompanyName(companyName);
  const passwordHash = await bcrypt.hash(password, 10);

  companies.push({
    companyId,
    companyName,
    passwordHash,
    createdAt: new Date().toISOString()
  });

  writeJson(COMPANIES_FILE, companies);

  res.json({ success: true, companyId, companyName });
});

app.post("/login", async (req, res) => {
  const { companyName, password } = req.body;

  if (!companyName || !password) {
    return res.status(400).json({ message: "Company name and password are required" });
  }

  const companies = readJson(COMPANIES_FILE, []);
  const company = companies.find(
    c => c.companyName.toLowerCase() === companyName.toLowerCase()
  );

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

  const companyData = getCompanyKnowledge(companyId);
const fixes = getAIFixes(companyId);

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

    const conversations = readJson(CONVERSATIONS_FILE, []);
    const finalConversationId = conversationId || Date.now().toString();

    conversations.push({
      id: Date.now().toString(),
      companyId,
      conversationId: finalConversationId,
      message,
      reply: answer,
      email: emailMatch ? emailMatch[0].toLowerCase() : null,
      time: new Date().toISOString()
    });

    writeJson(CONVERSATIONS_FILE, conversations);

    if (emailMatch) {
      const leads = readJson(LEADS_FILE, []);
      const existingLead = leads.find(
        l =>
          l.companyId === companyId &&
          l.email &&
          l.email.toLowerCase() === emailMatch[0].toLowerCase()
      );

      if (!existingLead) {
        leads.push({
          id: Date.now().toString(),
          companyId,
          name,
          email: emailMatch[0].toLowerCase(),
          time: new Date().toISOString()
        });

        writeJson(LEADS_FILE, leads);
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

app.get("/conversations", (req, res) => {
  const { companyId } = req.query;

  if (!companyId) {
    return res.status(400).json({ message: "companyId is required" });
  }

  const conversations = readJson(CONVERSATIONS_FILE, []);
  const companyConversations = conversations.filter(c => c.companyId === companyId);

  const grouped = {};

  companyConversations.forEach(msg => {
    if (!grouped[msg.conversationId]) {
      grouped[msg.conversationId] = [];
    }
    grouped[msg.conversationId].push(msg);
  });

  const result = Object.keys(grouped)
    .map(conversationId => {
      const messages = grouped[conversationId];
      const last = messages[messages.length - 1];

      return {
        conversationId,
        email: last.email || "Unknown contact",
        lastMessage: last.message || ""
      };
    })
    .sort((a, b) => Number(b.conversationId) - Number(a.conversationId));

  res.json(result);
});

app.get("/conversation-messages", (req, res) => {
  const { companyId, conversationId } = req.query;

  if (!companyId || !conversationId) {
    return res.status(400).json({ message: "companyId and conversationId are required" });
  }

  const conversations = readJson(CONVERSATIONS_FILE, []);
  const messages = conversations.filter(
    c => c.companyId === companyId && c.conversationId === conversationId
  );

  res.json(messages);
});

app.get("/lead-conversation", (req, res) => {
  const { companyId, email } = req.query;

  if (!companyId || !email) {
    return res.status(400).json({ message: "companyId and email are required" });
  }

  const conversations = readJson(CONVERSATIONS_FILE, []);
  const matches = conversations.filter(
    c =>
      c.companyId === companyId &&
      c.email &&
      c.email.toLowerCase() === email.toLowerCase()
  );

  res.json(matches);
});

app.get("/leads", (req, res) => {
  const { companyId } = req.query;

  if (!companyId) {
    return res.status(400).json({ message: "companyId is required" });
  }

  const leads = readJson(LEADS_FILE, []);
  const companyLeads = leads.filter(l => l.companyId === companyId);

  res.json(companyLeads);
});

app.delete("/delete-lead/:id", (req, res) => {
  const { id } = req.params;
  const { companyId } = req.query;

  if (!companyId) {
    return res.status(400).json({ message: "companyId is required" });
  }

  let leads = readJson(LEADS_FILE, []);
  leads = leads.filter(l => !(l.id === id && l.companyId === companyId));
  writeJson(LEADS_FILE, leads);

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

    const oldKnowledge = getCompanyKnowledge(companyId);
    saveCompanyKnowledge(companyId, `${oldKnowledge}\n\n${text}`.trim());

    res.json({ message: "PDF uploaded and processed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error reading PDF" });
  }
});

app.post("/save-website", async (req, res) => {
  const { url, companyId } = req.body;

  if (!url || !companyId) {
    return res.status(400).json({ message: "URL and companyId are required" });
  }

  try {
    const response = await axios.get(url, {
      httpsAgent: new https.Agent({
        rejectUnauthorized: false
      })
    });

    const html = response.data;
    const $ = cheerio.load(html);

    let text = "";
    $("p").each((i, el) => {
      text += $(el).text() + "\n";
    });

    const oldKnowledge = getCompanyKnowledge(companyId);
    saveCompanyKnowledge(companyId, `${oldKnowledge}\n\n${text}`.trim());

    res.json({ message: "Website saved and processed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error reading website" });
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