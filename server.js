require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Groq       = require('groq-sdk');
const path       = require('path');
const http       = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Per-class message history (kept in memory) ─────────────────────────────────
// Structure: { 1: [ {sender, text, type, timestamp} ], 2: [...], ... }
const classRooms = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

const classDescriptions = {
  1: 'Primary 1 – foundations of literacy, numeracy, and discovery.',
  2: 'Primary 2 – building reading, writing, and basic maths skills.',
  3: 'Primary 3 – expanding knowledge in science, maths, and language.',
  4: 'Primary 4 – introduction to structured learning and critical thinking.',
  5: 'Primary 5 – deeper subject exploration and project work.',
  6: 'Primary 6 – exam preparation and final year of primary school.',
};

function buildSystemPrompt(className, senderName) {
  return `You are the AI assistant for Corona School Chat — a school communication platform.
The student asking is: ${senderName}
Their class: ${className} (${classDescriptions[parseInt(className.replace('Class ', ''))] || ''})
Be warm, helpful, and age-appropriate. Keep answers clear and encouraging.
If asked who you are, say you are the Corona School Chat AI assistant.`;
}

// ── Socket.io ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // Helper: broadcast online users for a room
  function broadcastOnline(room) {
    const users = [];
    io.sockets.sockets.forEach(s => {
      if (s.data.room === room && s.data.name) users.push(s.data.name);
    });
    io.to(room).emit('onlineUsers', users);
  }

  // Student joins a class room
  socket.on('joinClass', ({ name, classNum }) => {
    // Leave any previous rooms (except own socket room)
    [...socket.rooms].forEach(r => { if (r !== socket.id) socket.leave(r); });

    const room = `class_${classNum}`;
    socket.join(room);
    socket.data.name     = name;
    socket.data.classNum = classNum;
    socket.data.room     = room;

    // Send existing history to the joining student
    socket.emit('history', classRooms[classNum] || []);

    // Notify others in the room
    const joinMsg = {
      sender:    'System',
      text:      `${name} joined Class ${classNum}`,
      type:      'system',
      timestamp: new Date().toISOString(),
    };
    socket.to(room).emit('message', joinMsg);
    broadcastOnline(room);
    console.log(`👤 ${name} joined Class ${classNum}`);
  });

  // Student sends a message
  socket.on('sendMessage', async ({ text }) => {
    const { name, classNum, room } = socket.data;
    if (!name || !room) return;

    const msg = {
      sender:    name,
      text:      text.trim(),
      type:      'student',
      timestamp: new Date().toISOString(),
    };

    // Save and broadcast to everyone in the room (including sender)
    classRooms[classNum].push(msg);
    io.to(room).emit('message', msg);

    // If message starts with @AI, trigger AI response
    if (text.trim().toLowerCase().startsWith('@ai')) {
      const question = text.trim().replace(/^@ai\s*/i, '').trim();
      if (!question) return;

      // Build conversation history for this class (student+AI messages only)
      const history = (classRooms[classNum] || [])
        .filter(m => m.type === 'student' || m.type === 'ai')
        .slice(-20) // last 20 messages for context
        .map(m => ({
          role:    m.type === 'ai' ? 'assistant' : 'user',
          content: m.type === 'ai' ? m.text : `${m.sender}: ${m.text}`,
        }));

      try {
        const completion = await groq.chat.completions.create({
          model:       'llama-3.1-8b-instant',
          messages:    [
            { role: 'system', content: buildSystemPrompt(`Class ${classNum}`, name) },
            ...history,
          ],
          max_tokens:  1000,
          temperature: 0.7,
          stream:      false,
        });

        const aiReply = completion.choices[0].message.content;
        const aiMsg = {
          sender:    'Corona AI',
          text:      aiReply,
          type:      'ai',
          replyTo:   name,
          timestamp: new Date().toISOString(),
        };

        classRooms[classNum].push(aiMsg);
        io.to(room).emit('message', aiMsg);

      } catch (err) {
        console.error('Groq error:', err.message);
        const errMsg = {
          sender:    'Corona AI',
          text:      '⚠️ Sorry, I could not process that. Please try again.',
          type:      'ai',
          timestamp: new Date().toISOString(),
        };
        io.to(room).emit('message', errMsg);
      }
    }
  });

  socket.on('disconnect', () => {
    const { name, classNum, room } = socket.data;
    if (name && room) {
      const leaveMsg = {
        sender:    'System',
        text:      `${name} left the chat`,
        type:      'system',
        timestamp: new Date().toISOString(),
      };
      socket.to(room).emit('message', leaveMsg);
      broadcastOnline(room);
    }
    console.log(`🔌 Disconnected: ${socket.id}`);
  });
});

// ── Petnan messages ────────────────────────────────────────────────────────────
app.post('/api/petnan', (req, res) => {
  const { message, timestamp } = req.body;
  console.log(`\n📩 [Message for Petnan] ${timestamp}`);
  console.log(`   "${message}"\n`);
  res.json({ ok: true });
});

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Corona School Chat server is running.' });
});

// ── Serve frontend ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🏫 Corona School Chat running at http://localhost:${PORT}`);
  console.log(`📌 Groq API key needed in .env: GROQ_API_KEY=gsk_...`);
  console.log(`💬 Real-time chat enabled via Socket.io\n`);
});
