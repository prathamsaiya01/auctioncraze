import { io, Socket } from 'socket.io-client';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:4001';

let socketInstance: Socket | null = null;
let currentToken: string | null = null;

export function getRoomSocket(token: string): Socket {
  if (socketInstance && currentToken !== token) {
    socketInstance.disconnect();
    socketInstance = null;
  }

  if (!socketInstance) {
    currentToken = token;
    socketInstance = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });
  }

  return socketInstance;
}

export function disconnectRoomSocket(): void {
  if (socketInstance) {
    socketInstance.disconnect();
    socketInstance = null;
    currentToken = null;
  }
}
