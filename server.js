const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
const suits = ["♠","♥","♦","♣"];
const values = ["A","K","Q","J","10","9","8","7","6"];

function newDeck() {
  return suits.flatMap(s => values.map(v => ({v, s})))
    .sort(() => Math.random() - 0.5);
}
function code() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}
function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map(p => ({
      id:p.id, name:p.name, cards:p.hand.length, ready:p.ready
    })),
    center: room.center.length,
    card: room.lastCard,
    turn: room.turn,
    pending: room.pending
  };
}
function emitRoom(room) { io.to(room.code).emit("state", publicState(room)); }

function startGame(room) {
  if (room.players.length !== 3) return;
  const deck = newDeck();
  room.players.forEach(p => { p.hand=[]; p.ready=false; });
  for (let i=0;i<36;i++) room.players[i%3].hand.push(deck.pop());
  room.deck=deck; room.center=[]; room.phase="playing";
  room.turn=0; room.lastCard=null; room.pending=null; room.reactionDeadline=0;
  emitRoom(room);
}

function roomForSocket(socket) {
  for (const room of rooms.values())
    if (room.players.some(p => p.id===socket.id)) return room;
  return null;
}

function nextTurn(room) {
  room.turn = (room.turn + 1) % room.players.length;
  room.pending=null; room.reactionDeadline=0;
  emitRoom(room);
}

function winIfNeeded(room, player) {
  if (player.hand.length === 0) {
    room.phase="finished";
    room.winner=player.name;
    io.to(room.code).emit("finished", {winner:player.name});
    emitRoom(room);
    return true;
  }
  return false;
}

io.on("connection", socket => {
  socket.on("createRoom", ({name}) => {
    let c; do c=code(); while(rooms.has(c));
    const room={code:c,phase:"lobby",players:[],center:[],deck:[],turn:0,lastCard:null,pending:null};
    rooms.set(c,room);
    room.players.push({id:socket.id,name:(name||"Игрок").slice(0,20),hand:[],ready:false});
    socket.join(c); socket.emit("joined",{code:c}); emitRoom(room);
  });

  socket.on("joinRoom", ({name,roomCode}) => {
    const room=rooms.get(String(roomCode||"").toUpperCase());
    if(!room) return socket.emit("errorMessage","Комната не найдена.");
    if(room.phase!=="lobby") return socket.emit("errorMessage","Игра уже началась.");
    if(room.players.length>=3) return socket.emit("errorMessage","Комната заполнена.");
    room.players.push({id:socket.id,name:(name||"Игрок").slice(0,20),hand:[],ready:false});
    socket.join(room.code); socket.emit("joined",{code:room.code}); emitRoom(room);
  });

  socket.on("ready", () => {
    const room=roomForSocket(socket); if(!room) return;
    const p=room.players.find(x=>x.id===socket.id); p.ready=!p.ready;
    if(room.players.length===3 && room.players.every(x=>x.ready)) startGame(room);
    else emitRoom(room);
  });

  socket.on("playCard", () => {
    const room=roomForSocket(socket); if(!room || room.phase!=="playing") return;
    const idx=room.players.findIndex(p=>p.id===socket.id);
    if(idx!==room.turn || room.pending) return;
    const p=room.players[idx];
    if(!p.hand.length) return;
    const card=p.hand.shift();
    room.center.push(card); room.lastCard=card;

    if(["10","J","Q","K","A"].includes(card.v)) {
      room.pending=card.v;
      room.reactionDeadline=Date.now()+1200;
    } else {
      if(!winIfNeeded(room,p)) nextTurn(room);
      return;
    }
    emitRoom(room);
  });

  socket.on("reaction", ({value}) => {
    const room=roomForSocket(socket); if(!room || room.phase!=="playing" || !room.pending) return;
    const p=room.players.find(x=>x.id===socket.id);
    if(!p) return;
    const expected=room.pending;
    // Correct rule: center stays on the table after a successful reaction.
    if(value===expected) {
      room.pending=null; room.reactionDeadline=0;
      emitRoom(room);
      return;
    }
    p.hand.push(...room.center);
    room.center=[];
    room.pending=null; room.reactionDeadline=0;
    if(!winIfNeeded(room,p)) nextTurn(room);
  });

  socket.on("disconnect", () => {
    const room=roomForSocket(socket);
    if(!room) return;
    room.players=room.players.filter(p=>p.id!==socket.id);
    if(room.players.length===0) rooms.delete(room.code);
    else { room.phase="lobby"; room.center=[]; room.pending=null; emitRoom(room); }
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if(room.phase==="playing" && room.pending && Date.now()>room.reactionDeadline) {
      const p=room.players[room.turn];
      p.hand.push(...room.center); room.center=[]; room.pending=null;
      if(!winIfNeeded(room,p)) nextTurn(room);
    }
  }
}, 100);

server.listen(process.env.PORT || 3000, () =>
  console.log("Бонжур, мадам! server started")
);
