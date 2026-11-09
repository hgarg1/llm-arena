import { createServer } from 'http';
import { Server } from 'socket.io';
import { createApp } from './app';
import { isDatabaseConfigured } from './config/runtime';
import { ensureDefaultGamesOnce } from './services/default-games.service';
import { activateDueScheduledGames } from './services/game-release.service';

const PORT = process.env.PORT || 3000;
const httpServer = createServer();
const io = new Server(httpServer);
const app = createApp({ io });

httpServer.on('request', app);

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

if (isDatabaseConfigured()) {
  // Seeding and scheduled go-lives run in the background, not as a side effect of page views.
  ensureDefaultGamesOnce().catch(err => console.error('Failed to seed default games:', err));
  const tick = () => activateDueScheduledGames().catch(err => console.error('Scheduled game activation failed:', err));
  tick();
  setInterval(tick, 60_000).unref();
}
