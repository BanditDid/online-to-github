const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const yts = require('yt-search');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Multi-room state management
const rooms = {};

// Helper to generate a room ID
const generateRoomId = () => Math.floor(100000 + Math.random() * 900000).toString();

// Search API using ytsr
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    const karaokeOnly = req.query.karaokeOnly !== 'false'; // Default to true
    if (!query) return res.status(400).json({ error: 'Query is required' });

    try {
        // Optionally enforce "karaoke" search
        const searchQuery = karaokeOnly ? `${query} karaoke` : query;
        const searchResults = await yts(searchQuery);
        const songs = searchResults.videos.slice(0, 15).map(video => ({
            id: video.videoId,
            title: video.title,
            thumbnail: video.thumbnail,
            duration: video.timestamp,
            author: video.author.name
        }));
        res.json(songs);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Failed to search YouTube' });
    }
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('create-room', () => {
        const roomId = generateRoomId();
        rooms[roomId] = { host: socket.id, queue: [], currentSong: null };
        socket.join(roomId);
        socket.emit('room-created', roomId);
    });

    socket.on('join-room', (roomId) => {
        if (rooms[roomId]) {
            socket.join(roomId);
            socket.emit('room-joined', { roomId, queue: rooms[roomId].queue, currentSong: rooms[roomId].currentSong });
            console.log(`User ${socket.id} joined room ${roomId}`);
        } else {
            socket.emit('error', 'Room not found');
        }
    });

    // Request full sync (for periodic sync or manual refresh)
    socket.on('request-sync', (roomId) => {
        if (rooms[roomId]) {
            socket.emit('full-sync', {
                queue: rooms[roomId].queue,
                currentSong: rooms[roomId].currentSong
            });
        }
    });

    socket.on('add-to-queue', ({ roomId, song }) => {
        if (rooms[roomId]) {
            rooms[roomId].queue.push(song);
            io.to(roomId).emit('queue-updated', rooms[roomId].queue);

            // If nothing is playing, tell host to play
            if (!rooms[roomId].currentSong) {
                // We'll let the host handle the "play next" logic
            }
        }
    });

    socket.on('player-state', ({ roomId, isPlaying, volume, currentTime, duration }) => {
        if (rooms[roomId]) {
            socket.to(roomId).emit('player-state', { isPlaying, volume, currentTime, duration });
        }
    });

    socket.on('request-next', (roomId) => {
        if (rooms[roomId] && rooms[roomId].queue.length > 0) {
            rooms[roomId].currentSong = rooms[roomId].queue.shift();
            io.to(roomId).emit('play-song', rooms[roomId].currentSong);
            io.to(roomId).emit('queue-updated', rooms[roomId].queue);
        } else if (rooms[roomId]) {
            rooms[roomId].currentSong = null;
            io.to(roomId).emit('play-song', null);
        }
    });

    socket.on('skip-song', (roomId) => {
        if (rooms[roomId]) {
            socket.to(rooms[roomId].host).emit('force-skip');
        }
    });

    socket.on('clear-queue', (roomId) => {
        if (rooms[roomId]) {
            rooms[roomId].queue = [];
            io.to(roomId).emit('queue-updated', rooms[roomId].queue);
        }
    });

    socket.on('remove-from-queue', ({ roomId, index }) => {
        const idx = parseInt(index);
        if (rooms[roomId] && idx >= 0 && idx < rooms[roomId].queue.length) {
            rooms[roomId].queue.splice(idx, 1);
            io.to(roomId).emit('queue-updated', rooms[roomId].queue);
        }
    });

    socket.on('play-specific', ({ roomId, index }) => {
        const idx = parseInt(index);
        if (rooms[roomId] && idx >= 0 && idx < rooms[roomId].queue.length) {
            const song = rooms[roomId].queue.splice(idx, 1)[0];
            rooms[roomId].currentSong = song;
            io.to(roomId).emit('play-song', rooms[roomId].currentSong);
            io.to(roomId).emit('queue-updated', rooms[roomId].queue);
        }
    });

    socket.on('toggle-play', (roomId) => {
        if (rooms[roomId]) {
            socket.to(rooms[roomId].host).emit('toggle-play');
        }
    });

    socket.on('set-volume', ({ roomId, volume }) => {
        if (rooms[roomId]) {
            socket.to(rooms[roomId].host).emit('set-volume', volume);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Optional: Clean up empty rooms
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
