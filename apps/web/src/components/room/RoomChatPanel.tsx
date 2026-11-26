'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChatMessageDto,
  RoomChatStateDto,
  RoomParticipantDto,
  RoomRole,
  SOCKET_EVENTS
} from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { getRoomSocket } from '@/lib/socket';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Ban,
  Eye,
  MessageSquare,
  Send,
  Shield,
  Trash2,
  VolumeX,
  X
} from 'lucide-react';

interface RoomChatPanelProps {
  roomCode: string;
  token: string;
  mySessionId: string;
  myRole: RoomRole | null;
  isHost: boolean;
  participants: RoomParticipantDto[];
}

export function RoomChatPanel({
  roomCode,
  token,
  mySessionId,
  myRole,
  isHost,
  participants
}: RoomChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [spectatorChatEnabled, setSpectatorChatEnabled] = useState(false);
  const [isMutedInRoom, setIsMutedInRoom] = useState(false);

  const [isOpenDesktop, setIsOpenDesktop] = useState(false);
  const [isOpenMobile, setIsOpenMobile] = useState(false);
  const [showModeration, setShowModeration] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const [draft, setDraft] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const isOpenRef = useRef(false);

  useEffect(() => {
    const open = isOpenDesktop || isOpenMobile;
    isOpenRef.current = open;
    if (open) {
      setUnreadCount(0);
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isOpenDesktop, isOpenMobile, messages.length]);

  const fetchChatHistory = useCallback(async () => {
    if (!token || !roomCode) return;
    try {
      const res: any = await api.get(`/rooms/${roomCode}/chat`);
      const data: RoomChatStateDto | undefined = res?.data;
      if (!data) return;
      setMessages(data.messages || []);
      setChatEnabled(data.chatEnabled);
      setSpectatorChatEnabled(data.spectatorChatEnabled);
      setIsMutedInRoom(data.isMuted);
    } catch {
      // Ignore transient errors during initial room join transitions
    }
  }, [token, roomCode]);

  useEffect(() => {
    fetchChatHistory();
  }, [fetchChatHistory]);

  useEffect(() => {
    if (!token || !roomCode) return;
    const socket = getRoomSocket(token);

    const onChatMessage = (msg: ChatMessageDto) => {
      if (!msg?.id) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev.slice(-149), msg];
      });
      if (!isOpenRef.current && msg.guestSessionId !== mySessionId) {
        setUnreadCount((c) => c + 1);
      }
    };

    const onMessageDeleted = (evt: { messageId?: string }) => {
      if (!evt?.messageId) return;
      setMessages((prev) => prev.filter((m) => m.id !== evt.messageId));
    };

    const onSettingsUpdated = (evt: { chatEnabled?: boolean; spectatorChatEnabled?: boolean }) => {
      if (typeof evt?.chatEnabled === 'boolean') setChatEnabled(evt.chatEnabled);
      if (typeof evt?.spectatorChatEnabled === 'boolean') {
        setSpectatorChatEnabled(evt.spectatorChatEnabled);
      }
    };

    const onParticipantMuted = (evt: { guestSessionId?: string; isChatMuted?: boolean }) => {
      if (evt?.guestSessionId === mySessionId && typeof evt?.isChatMuted === 'boolean') {
        setIsMutedInRoom(evt.isChatMuted);
      }
    };

    const onReconnect = () => {
      fetchChatHistory();
    };

    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, onChatMessage);
    socket.on(SOCKET_EVENTS.CHAT_MESSAGE_DELETED, onMessageDeleted);
    socket.on(SOCKET_EVENTS.CHAT_SETTINGS_UPDATED, onSettingsUpdated);
    socket.on(SOCKET_EVENTS.CHAT_PARTICIPANT_MUTED, onParticipantMuted);
    socket.on('connect', onReconnect);

    return () => {
      socket.off(SOCKET_EVENTS.CHAT_MESSAGE, onChatMessage);
      socket.off(SOCKET_EVENTS.CHAT_MESSAGE_DELETED, onMessageDeleted);
      socket.off(SOCKET_EVENTS.CHAT_SETTINGS_UPDATED, onSettingsUpdated);
      socket.off(SOCKET_EVENTS.CHAT_PARTICIPANT_MUTED, onParticipantMuted);
      socket.off('connect', onReconnect);
    };
  }, [token, roomCode, mySessionId, fetchChatHistory]);

  const canSend =
    chatEnabled &&
    !isMutedInRoom &&
    (myRole !== RoomRole.SPECTATOR || spectatorChatEnabled);

  const disabledReason = !chatEnabled
    ? 'Room chat is paused by host.'
    : isMutedInRoom
    ? 'You are muted in chat by the host.'
    : myRole === RoomRole.SPECTATOR && !spectatorChatEnabled
    ? 'Spectator chat is disabled by host.'
    : null;

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    setChatError(null);
    const clean = draft.trim();
    if (!clean || !canSend || isSending) return;

    setIsSending(true);
    const idempotencyKey = `chat-${roomCode}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const socket = getRoomSocket(token);
    socket.emit(
      SOCKET_EVENTS.CHAT_SEND,
      { roomCode, message: clean, idempotencyKey },
      (ack: any) => {
        setIsSending(false);
        if (ack?.ok) {
          setDraft('');
          if (ack.data?.id) {
            setMessages((prev) =>
              prev.some((m) => m.id === ack.data.id) ? prev : [...prev.slice(-149), ack.data]
            );
          }
        } else {
          setChatError(ack?.message || 'Unable to send message.');
        }
      }
    );
  };

  const handleToggleSetting = async (patch: { chatEnabled?: boolean; spectatorChatEnabled?: boolean }) => {
    try {
      await api.patch(`/rooms/${roomCode}/chat/settings`, patch);
    } catch (err: any) {
      setChatError(err?.message || 'Unable to update chat moderation settings.');
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    try {
      await api.delete(`/rooms/${roomCode}/chat/${messageId}`);
    } catch (err: any) {
      setChatError(err?.message || 'Unable to delete message.');
    }
  };

  const handleMuteToggle = async (participantId: string, currentlyMuted: boolean) => {
    try {
      await api.post(`/rooms/${roomCode}/chat/participants/${participantId}/mute`, {
        muted: !currentlyMuted
      });
    } catch (err: any) {
      setChatError(err?.message || 'Unable to update mute state.');
    }
  };

  const renderPanelContent = (onClose: () => void) => (
    <div className="flex flex-col h-full bg-stadium-bg border border-stadium-border rounded-2xl shadow-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-stadium-border bg-stadium-surface/95 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-gold-400" />
          <h3 className="font-display text-lg font-bold text-white tracking-wide">ROOM CHAT</h3>
          <Badge tone={chatEnabled ? 'sold' : 'unsold'}>{chatEnabled ? 'LIVE' : 'OFF'}</Badge>
        </div>
        <div className="flex items-center gap-1.5">
          {isHost && (
            <button
              type="button"
              onClick={() => setShowModeration((v) => !v)}
              data-testid="chat-moderation-toggle-btn"
              className={`px-2 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
                showModeration
                  ? 'bg-electric-500/20 border-electric-400 text-electric-200'
                  : 'border-stadium-border text-stadium-muted hover:text-white'
              }`}
            >
              <Shield className="w-3 h-3 inline mr-1" />
              Mod
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            data-testid="close-chat-panel-btn"
            aria-label="Close room chat"
            className="p-1 rounded-lg text-stadium-muted hover:text-white hover:bg-white/5"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {isHost && showModeration && (
        <div
          className="px-3.5 py-2.5 border-b border-stadium-border bg-stadium-card/85 space-y-2 text-xs"
          data-testid="chat-moderation-controls"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-stadium-text">Enable Room Chat</span>
            <button
              type="button"
              data-testid="host-toggle-room-chat"
              onClick={() => handleToggleSetting({ chatEnabled: !chatEnabled })}
              className={`px-2.5 py-0.5 rounded font-semibold ${
                chatEnabled ? 'bg-signal-sold/20 text-signal-sold' : 'bg-signal-unsold/20 text-signal-unsold'
              }`}
            >
              {chatEnabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-stadium-text flex items-center gap-1">
              <Eye className="w-3 h-3 text-electric-400" /> Allow Spectator Chat
            </span>
            <button
              type="button"
              data-testid="host-toggle-spectator-chat"
              onClick={() => handleToggleSetting({ spectatorChatEnabled: !spectatorChatEnabled })}
              className={`px-2.5 py-0.5 rounded font-semibold ${
                spectatorChatEnabled
                  ? 'bg-signal-sold/20 text-signal-sold'
                  : 'bg-white/10 text-stadium-muted'
              }`}
            >
              {spectatorChatEnabled ? 'Allowed' : 'Owners Only'}
            </button>
          </div>
          {participants.filter((p) => p.role !== RoomRole.HOST).length > 0 && (
            <div className="pt-1 border-t border-stadium-border max-h-24 overflow-y-auto space-y-1">
              {participants
                .filter((p) => p.role !== RoomRole.HOST)
                .map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] text-stadium-muted">
                      {p.displayName} {p.franchiseCode ? `(${p.franchiseCode})` : '(Spec)'}
                    </span>
                    <button
                      type="button"
                      data-testid={`mute-participant-${p.id}`}
                      onClick={() => handleMuteToggle(p.id, Boolean(p.isChatMuted))}
                      className="text-[10px] px-2 py-0.5 rounded border border-stadium-border hover:border-white/40 text-white shrink-0"
                    >
                      {p.isChatMuted ? 'Unmute' : 'Mute'}
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Messages feed */}
      <div
        className="flex-1 overflow-y-auto px-3.5 py-3 space-y-2.5 min-h-[220px]"
        data-testid="chat-messages-list"
      >
        {messages.length === 0 ? (
          <p className="text-xs text-stadium-muted text-center py-8">
            No messages yet. Say hello to other franchises without interrupting the gavel!
          </p>
        ) : (
          messages.map((m) => {
            const isMine = m.guestSessionId === mySessionId;
            return (
              <div
                key={m.id}
                data-testid={`chat-msg-${m.id}`}
                className={`rounded-xl border px-3 py-2 text-xs space-y-1 ${
                  isMine
                    ? 'bg-gold-500/10 border-gold-500/35'
                    : 'bg-stadium-card/75 border-stadium-border'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="font-bold text-white truncate">{m.senderName}</span>
                    {m.franchiseDisplayName && (
                      <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] font-mono text-gold-300 truncate max-w-[140px]">
                        {m.franchiseDisplayName}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px] font-mono text-stadium-muted">
                      {new Date(m.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                    {isHost && (
                      <button
                        type="button"
                        onClick={() => handleDeleteMessage(m.id)}
                        data-testid={`delete-chat-msg-${m.id}`}
                        aria-label="Delete chat message"
                        className="text-stadium-muted hover:text-signal-unsold transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-stadium-text break-words whitespace-pre-wrap leading-relaxed">
                  {m.message}
                </p>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Footer Composer */}
      <div className="p-3 border-t border-stadium-border bg-stadium-surface/90 space-y-2">
        {chatError && (
          <p className="text-[11px] text-signal-unsold flex items-center gap-1" data-testid="chat-error-banner">
            <Ban className="w-3 h-3 shrink-0" />
            {chatError}
          </p>
        )}
        {disabledReason ? (
          <div
            data-testid="chat-disabled-banner"
            className="text-xs text-stadium-muted bg-stadium-card/80 border border-stadium-border rounded-xl px-3 py-2 flex items-center gap-2"
          >
            <VolumeX className="w-3.5 h-3.5 text-signal-warn shrink-0" />
            <span>{disabledReason}</span>
          </div>
        ) : (
          <form onSubmit={handleSend} className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={360}
              placeholder="Send room message..."
              data-testid="chat-input"
              className="flex-1 rounded-xl bg-stadium-bg border border-stadium-border px-3 py-2 text-xs text-white focus:outline-none focus:border-gold-400"
            />
            <Button
              type="submit"
              variant="gold"
              size="sm"
              disabled={!draft.trim() || isSending}
              data-testid="chat-send-btn"
              aria-label="Send message"
            >
              <Send className="w-3.5 h-3.5" />
            </Button>
          </form>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Floating / Docked Compact Chat Launcher Button (Bottom-Right, stays clear of center bidding controls) */}
      <div className="fixed bottom-4 right-4 z-40">
        {!isOpenDesktop && !isOpenMobile && (
          <button
            type="button"
            onClick={() => {
              if (typeof window !== 'undefined' && window.innerWidth < 768) {
                setIsOpenMobile(true);
              } else {
                setIsOpenDesktop(true);
              }
            }}
            data-testid="open-chat-btn"
            className="flex items-center gap-2 rounded-full border border-gold-500/45 bg-stadium-surface/95 backdrop-blur-md px-4 py-2.5 text-xs font-bold text-white shadow-xl hover:border-gold-400 transition-all"
          >
            <MessageSquare className="w-4 h-4 text-gold-400" />
            <span>Chat</span>
            {unreadCount > 0 && (
              <span
                data-testid="chat-unread-badge"
                className="px-1.5 py-0.5 rounded-full bg-gold-500 text-stadium-canvas font-mono text-[10px] font-extrabold"
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Desktop Collapsible Side Panel */}
      {isOpenDesktop && (
        <div
          className="hidden md:block fixed bottom-4 right-4 z-40 w-[350px] h-[470px]"
          data-testid="chat-desktop-panel"
        >
          {renderPanelContent(() => setIsOpenDesktop(false))}
        </div>
      )}

      {/* Mobile Slide-Up Drawer */}
      {isOpenMobile && (
        <div
          className="md:hidden fixed inset-x-0 bottom-0 z-50 h-[62vh] px-2 pb-2"
          data-testid="chat-mobile-drawer"
        >
          {renderPanelContent(() => setIsOpenMobile(false))}
        </div>
      )}
    </>
  );
}
