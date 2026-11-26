import http from 'http';
import { prisma } from '@auctioncraze/database';
import { createApp } from './app';
import { config } from './config/env';
import { connectRedis, disconnectRedis } from './lib/redis';
import { setupSocketServer, closeSocketServer } from './sockets/socketServer';
import { AuctionTimerManager } from './modules/auction/timerManager';

async function bootstrap() {
  await prisma.$connect();
  console.log('✅ PostgreSQL connected.');

  await connectRedis();
  console.log('✅ Redis connected.');

  const app = createApp();
  const server = http.createServer(app);

  await setupSocketServer(server);
  console.log('✅ Socket.IO server + Redis adapter initialized.');

  AuctionTimerManager.start(250);
  console.log('✅ Server-authoritative Redis auction timer engine started.');

  server.listen(config.port, () => {
    console.log(
      `🚀 AuctionCraze API listening on port ${config.port} (${config.nodeEnv}, trustProxyHops=${config.trustProxyHops}).`
    );
  });

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    AuctionTimerManager.stop();
    await closeSocketServer();
    await disconnectRedis();
    await prisma.$disconnect();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
