import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { PidorGame } from './gameLogic.js';

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const games: Record<string, PidorGame> = {};

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, playerName }) => {
    socket.join(roomId);
    if (!games[roomId]) {
      games[roomId] = new PidorGame([]);
      games[roomId].onPenalty = (playerId, reason) => {
        io.to(roomId).emit('penalty', { playerId, reason });
      };
    }
    const game = games[roomId];
    const existing = game.state.players.find(p => p.name === playerName);
    if (existing) {
      existing.id = socket.id;
    } else {
      game.state.players.push({
        id: socket.id, name: playerName, hand: [], stumps: [], penalties: 0,
        isReady: false, onDuty: false, hasExited: false
      });
    }
    io.to(roomId).emit('gameStateUpdate', game.state);
  });

  socket.on('startGame', (roomId) => {
    const game = games[roomId];
    if (game) { game.start(); io.to(roomId).emit('gameStateUpdate', game.state); }
  });

  socket.on('drawCardFromDeck', ({ roomId }) => {
    const game = games[roomId];
    if (game && game.takeFromDeck(socket.id)) io.to(roomId).emit('gameStateUpdate', game.state);
    else if (game) io.to(roomId).emit('gameStateUpdate', game.state); // Update for penalties
  });

  socket.on('takeFromPile', ({ roomId, cardId }) => {
    const game = games[roomId];
    if (game && game.takeFromPile(socket.id, cardId)) io.to(roomId).emit('gameStateUpdate', game.state);
  });

  socket.on('placeActiveCard', ({ roomId, targetPlayerId }) => {
    const game = games[roomId];
    if (game && game.placeActiveCard(socket.id, targetPlayerId)) io.to(roomId).emit('gameStateUpdate', game.state);
    else if (game) io.to(roomId).emit('gameStateUpdate', game.state);
  });

  socket.on('givePenaltyCard', ({ roomId, cardId, receiverId }) => {
    const game = games[roomId];
    if (game && game.givePenaltyCard(socket.id, cardId, receiverId)) io.to(roomId).emit('gameStateUpdate', game.state);
    else if (game) io.to(roomId).emit('gameStateUpdate', game.state);
  });

  socket.on('playCard', ({ roomId, cardId }) => {
    const game = games[roomId];
    if (game) { game.playCard(socket.id, cardId); io.to(roomId).emit('gameStateUpdate', game.state); }
  });

  socket.on('takeTrick', ({ roomId }) => {
    const game = games[roomId];
    if (game) { game.takeTrick(socket.id); io.to(roomId).emit('gameStateUpdate', game.state); }
  });

  socket.on('takeStumps', ({ roomId }) => {
    const game = games[roomId];
    if (game) { game.takeStumps(socket.id); io.to(roomId).emit('gameStateUpdate', game.state); }
  });

  socket.on('exitGame', ({ roomId }) => {
    const game = games[roomId];
    if (game) { game.exitGame(socket.id); io.to(roomId).emit('gameStateUpdate', game.state); }
  });

  socket.on('sayPhrase', ({ roomId, phrase }) => {
    io.to(roomId).emit('playerMessage', { playerId: socket.id, message: phrase });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
