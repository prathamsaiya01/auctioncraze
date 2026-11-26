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
  if (config.enableRedis) {
    console.log('✅ Redis connected.');
  }

  const app = createApp();
  const server = http.createServer(app);

  await setupSocketServer(server);
  console.log(
    config.enableRedis
      ? '✅ Socket.IO server + Redis adapter initialized.'
      : '✅ Socket.IO server initialized (single-instance memory adapter).'
  );

  AuctionTimerManager.start(250);
  console.log(
    config.enableRedis
      ? '✅ Server-authoritative Redis auction timer engine started.'
      : '✅ Server-authoritative in-process auction timer engine started (zero idle DB polling).'
  );

  server.listen(config.port, () => {
    console.log(
      `🚀 AuctionCraze API listening on port ${config.port} (${config.nodeEnv}, redis=${config.enableRedis}, ml=${config.enableMlService}, trustProxyHops=${config.trustProxyHops}).`
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
