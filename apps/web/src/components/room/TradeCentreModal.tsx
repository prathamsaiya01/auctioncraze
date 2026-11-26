'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AuctionFranchiseStateDto,
  RoomStatus,
  SOCKET_EVENTS,
  SquadMemberDto,
  TradeCenterStateDto,
  TradeProposalDto
} from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { formatLakhs } from '@/lib/formatPrice';
import { getRoomSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { ArrowLeftRight, CheckCircle2, Clock, History, Send, ShieldAlert, XCircle } from 'lucide-react';

interface TradeCentreModalProps {
  open: boolean;
  onClose: () => void;
  roomCode: string;
  allowPlayerTrades: boolean;
  roomStatus: RoomStatus;
  myFranchise: AuctionFranchiseStateDto;
  franchises: AuctionFranchiseStateDto[];
  maxSquadSize: number;
  maxOverseas: number;
  onTradeChanged?: () => void;
}

type TradeTab = 'PROPOSE' | 'INCOMING' | 'OUTGOING' | 'HISTORY';

export function TradeCentreModal({
  open,
  onClose,
  roomCode,
  allowPlayerTrades,
  roomStatus,
  myFranchise,
  franchises,
  maxSquadSize,
  maxOverseas,
  onTradeChanged
}: TradeCentreModalProps) {
  const { token } = useSessionStore();
  const [tab, setTab] = useState<TradeTab>('PROPOSE');
  const [tradeState, setTradeState] = useState<TradeCenterStateDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const partnerOptions = useMemo(
    () =>
      franchises.filter(
        (f) => f.id !== myFranchise.id && Boolean(f.ownerParticipantId)
      ),
    [franchises, myFranchise.id]
  );

  const [selectedPartnerId, setSelectedPartnerId] = useState<string>('');
  const [outgoingIds, setOutgoingIds] = useState<string[]>([]);
  const [incomingIds, setIncomingIds] = useState<string[]>([]);
  const [tradeNote, setTradeNote] = useState('');

  useEffect(() => {
    if (!selectedPartnerId || !partnerOptions.some((p) => p.id === selectedPartnerId)) {
      setSelectedPartnerId(partnerOptions[0]?.id || '');
      setIncomingIds([]);
    }
  }, [partnerOptions, selectedPartnerId]);

  const partnerFranchise = useMemo(
    () => partnerOptions.find((p) => p.id === selectedPartnerId) || null,
    [partnerOptions, selectedPartnerId]
  );

  const fetchTrades = useCallback(async () => {
    if (!roomCode || !token) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const res: any = await api.get(`/rooms/${roomCode}/trades`);
      setTradeState(res.data as TradeCenterStateDto);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to load franchise trade proposals.');
    } finally {
      setLoading(false);
    }
  }, [roomCode, token]);

  useEffect(() => {
    if (open) {
      fetchTrades();
    }
  }, [open, fetchTrades]);

  useEffect(() => {
    if (!open || !token) return;
    const socket = getRoomSocket(token);
    const onTradeEvent = () => {
      fetchTrades();
      onTradeChanged?.();
    };
    socket.on(SOCKET_EVENTS.TRADE_PROPOSED, onTradeEvent);
    socket.on(SOCKET_EVENTS.TRADE_ACCEPTED, onTradeEvent);
    socket.on(SOCKET_EVENTS.TRADE_REJECTED, onTradeEvent);
    socket.on(SOCKET_EVENTS.TRADE_CANCELLED, onTradeEvent);
    socket.on(SOCKET_EVENTS.TRADE_EXPIRED, onTradeEvent);
    return () => {
      socket.off(SOCKET_EVENTS.TRADE_PROPOSED, onTradeEvent);
      socket.off(SOCKET_EVENTS.TRADE_ACCEPTED, onTradeEvent);
      socket.off(SOCKET_EVENTS.TRADE_REJECTED, onTradeEvent);
      socket.off(SOCKET_EVENTS.TRADE_CANCELLED, onTradeEvent);
      socket.off(SOCKET_EVENTS.TRADE_EXPIRED, onTradeEvent);
    };
  }, [open, token, fetchTrades, onTradeChanged]);

  const selectedOutgoingPlayers: SquadMemberDto[] = useMemo(
    () => myFranchise.squad.filter((p) => outgoingIds.includes(p.playerId)),
    [myFranchise.squad, outgoingIds]
  );

  const selectedIncomingPlayers: SquadMemberDto[] = useMemo(
    () => (partnerFranchise?.squad || []).filter((p) => incomingIds.includes(p.playerId)),
    [partnerFranchise, incomingIds]
  );

  const togglePlayer = (list: string[], setList: (v: string[]) => void, playerId: string) => {
    setList(list.includes(playerId) ? list.filter((x) => x !== playerId) : [...list, playerId]);
  };

  const handlePropose = async () => {
    if (!partnerFranchise || outgoingIds.length === 0 || incomingIds.length === 0) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setActingId('PROPOSE');
    try {
      const idempotencyKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `trade-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      await api.post(`/rooms/${roomCode}/trades`, {
        receiverFranchiseId: partnerFranchise.id,
        outgoingPlayerIds: outgoingIds,
        incomingPlayerIds: incomingIds,
        note: tradeNote.trim() || undefined,
        expiresInMinutes: 15,
        idempotencyKey
      });
      setOutgoingIds([]);
      setIncomingIds([]);
      setTradeNote('');
      setSuccessMsg(`Trade proposal sent to ${partnerFranchise.displayName}.`);
      await fetchTrades();
      setTab('OUTGOING');
      onTradeChanged?.();
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to submit trade proposal.');
    } finally {
      setActingId(null);
    }
  };

  const handleRespond = async (trade: TradeProposalDto, action: 'accept' | 'reject' | 'cancel') => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setActingId(trade.id);
    try {
      const idempotencyKey =
        action === 'accept'
          ? typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          : undefined;
      await api.post(`/rooms/${roomCode}/trades/${trade.id}/${action}`, {
        ...(idempotencyKey ? { idempotencyKey } : {})
      });
      setSuccessMsg(
        action === 'accept'
          ? `Trade accepted & squads swapped atomically with ${trade.proposerFranchiseDisplayName}.`
          : action === 'reject'
          ? `Trade proposal rejected.`
          : `Trade proposal cancelled.`
      );
      await fetchTrades();
      onTradeChanged?.();
    } catch (err: any) {
      setErrorMsg(err?.message || `Unable to ${action} trade proposal.`);
    } finally {
      setActingId(null);
    }
  };

  const myProjectedSquad = myFranchise.squadCount - outgoingIds.length + incomingIds.length;
  const myProjectedOverseas =
    myFranchise.overseasCount -
    selectedOutgoingPlayers.filter((p) => p.isOverseas).length +
    selectedIncomingPlayers.filter((p) => p.isOverseas).length;

  const partnerProjectedSquad = partnerFranchise
    ? partnerFranchise.squadCount - incomingIds.length + outgoingIds.length
    : 0;
  const partnerProjectedOverseas = partnerFranchise
    ? partnerFranchise.overseasCount -
      selectedIncomingPlayers.filter((p) => p.isOverseas).length +
      selectedOutgoingPlayers.filter((p) => p.isOverseas).length
    : 0;

  const lifecycleOk =
    roomStatus === RoomStatus.LIVE ||
    roomStatus === RoomStatus.PAUSED ||
    roomStatus === RoomStatus.COMPLETED;

  const incomingList = tradeState?.pendingIncoming || [];
  const outgoingList = tradeState?.pendingOutgoing || [];
  const historyList = tradeState?.history || [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Franchise Trade Centre"
      subtitle={`${myFranchise.displayName} • Player-for-player exchanges only (no purse or cash transfers)`}
    >
      <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1" data-testid="trade-centre-modal">
        {/* Status Banner */}
        {(!allowPlayerTrades || !lifecycleOk) && (
          <div
            data-testid="trades-disabled-banner"
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200 flex items-center gap-2"
          >
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              {!allowPlayerTrades
                ? 'Player trading is currently disabled by the Host. New proposals are blocked.'
                : 'Trading unlocks once the live auction begins.'}
            </span>
          </div>
        )}

        {errorMsg && (
          <div
            role="alert"
            className="rounded-xl border border-signal-unsold/45 bg-signal-unsold/10 px-3.5 py-2.5 text-xs text-signal-unsold flex items-center gap-2"
          >
            <XCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="rounded-xl border border-signal-sold/45 bg-signal-sold/10 px-3.5 py-2.5 text-xs text-signal-sold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="grid grid-cols-4 gap-1.5 rounded-xl bg-stadium-bg p-1 border border-stadium-border">
          {(
            [
              { key: 'PROPOSE', label: 'Propose Trade' },
              { key: 'INCOMING', label: `Incoming (${incomingList.length})` },
              { key: 'OUTGOING', label: `Outgoing (${outgoingList.length})` },
              { key: 'HISTORY', label: `History (${historyList.length})` }
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              data-testid={`trade-tab-${item.key.toLowerCase()}`}
              onClick={() => setTab(item.key)}
              className={`py-1.5 px-2 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-colors ${
                tab === item.key
                  ? 'bg-gold-500 text-stadium-canvas shadow'
                  : 'text-stadium-muted hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Tab 1: Propose New Player-for-Player Trade */}
        {tab === 'PROPOSE' && (
          <div className="space-y-4">
            {partnerOptions.length === 0 ? (
              <p className="text-xs text-stadium-muted py-4 text-center">
                No other active franchise owners have joined this room yet.
              </p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Select Trading Franchise
                  </label>
                  <select
                    data-testid="trade-partner-select"
                    value={selectedPartnerId}
                    onChange={(e) => {
                      setSelectedPartnerId(e.target.value);
                      setIncomingIds([]);
                    }}
                    className="w-full rounded-xl bg-stadium-card border border-stadium-border px-3 py-2 text-sm text-white focus:outline-none focus:border-gold-400"
                  >
                    {partnerOptions.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.displayName} ({f.squadCount}/{maxSquadSize} Players · {f.overseasCount} OS)
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {/* My Squad Selection */}
                  <Card className="p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between border-b border-stadium-border pb-2">
                      <h4 className="font-display text-sm font-bold text-white uppercase">
                        Your Outgoing ({myFranchise.presetCode})
                      </h4>
                      <span className="font-mono text-[11px] text-gold-300">
                        {outgoingIds.length} selected
                      </span>
                    </div>
                    {myFranchise.squad.length === 0 ? (
                      <p className="text-xs text-stadium-muted py-3 text-center">No players acquired yet.</p>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                        {myFranchise.squad.map((p) => {
                          const checked = outgoingIds.includes(p.playerId);
                          return (
                            <label
                              key={`out-${p.playerId}`}
                              className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs cursor-pointer transition-colors ${
                                checked
                                  ? 'bg-gold-500/15 border-gold-400 text-white'
                                  : 'bg-stadium-bg/70 border-stadium-border text-stadium-text hover:border-white/25'
                              }`}
                            >
                              <span className="flex items-center gap-2 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => togglePlayer(outgoingIds, setOutgoingIds, p.playerId)}
                                  className="rounded border-stadium-border"
                                />
                                <span className="truncate font-semibold">{p.fullName}</span>
                                {p.isOverseas && <Badge tone="electric">OS</Badge>}
                              </span>
                              <span className="font-mono text-[11px] text-stadium-muted shrink-0">
                                {formatLakhs(p.priceLakhs)}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </Card>

                  {/* Partner Squad Selection */}
                  <Card className="p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between border-b border-stadium-border pb-2">
                      <h4 className="font-display text-sm font-bold text-white uppercase">
                        Requested Incoming ({partnerFranchise?.presetCode})
                      </h4>
                      <span className="font-mono text-[11px] text-electric-400">
                        {incomingIds.length} selected
                      </span>
                    </div>
                    {!partnerFranchise || partnerFranchise.squad.length === 0 ? (
                      <p className="text-xs text-stadium-muted py-3 text-center">No players acquired yet.</p>
                    ) : (
                      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                        {partnerFranchise.squad.map((p) => {
                          const checked = incomingIds.includes(p.playerId);
                          return (
                            <label
                              key={`in-${p.playerId}`}
                              className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs cursor-pointer transition-colors ${
                                checked
                                  ? 'bg-electric-500/15 border-electric-400 text-white'
                                  : 'bg-stadium-bg/70 border-stadium-border text-stadium-text hover:border-white/25'
                              }`}
                            >
                              <span className="flex items-center gap-2 min-w-0">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => togglePlayer(incomingIds, setIncomingIds, p.playerId)}
                                  className="rounded border-stadium-border"
                                />
                                <span className="truncate font-semibold">{p.fullName}</span>
                                {p.isOverseas && <Badge tone="electric">OS</Badge>}
                              </span>
                              <span className="font-mono text-[11px] text-stadium-muted shrink-0">
                                {formatLakhs(p.priceLakhs)}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </Card>
                </div>

                {/* Proposal Summary & Limits Projection */}
                <Card highlight="gold" className="p-3.5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-white flex items-center gap-1.5">
                      <ArrowLeftRight className="w-3.5 h-3.5 text-gold-400" />
                      Trade Summary ({selectedOutgoingPlayers.length} ↔ {selectedIncomingPlayers.length})
                    </span>
                    <span className="font-mono text-[11px] text-stadium-muted">
                      {myFranchise.presetCode}: {myProjectedSquad}/{maxSquadSize} (OS {myProjectedOverseas}/{maxOverseas})
                      {partnerFranchise
                        ? ` • ${partnerFranchise.presetCode}: ${partnerProjectedSquad}/${maxSquadSize} (OS ${partnerProjectedOverseas}/${maxOverseas})`
                        : ''}
                    </span>
                  </div>

                  <input
                    type="text"
                    value={tradeNote}
                    maxLength={180}
                    onChange={(e) => setTradeNote(e.target.value)}
                    placeholder="Optional trade note (e.g. Swap pace depth for spin)"
                    className="w-full rounded-lg bg-stadium-bg border border-stadium-border px-3 py-1.5 text-xs text-white focus:outline-none focus:border-gold-400"
                  />

                  <div className="flex justify-end">
                    <Button
                      variant="gold"
                      size="sm"
                      disabled={
                        !allowPlayerTrades ||
                        !lifecycleOk ||
                        outgoingIds.length === 0 ||
                        incomingIds.length === 0 ||
                        actingId === 'PROPOSE'
                      }
                      isLoading={actingId === 'PROPOSE'}
                      onClick={handlePropose}
                      leftIcon={<Send className="w-3.5 h-3.5" />}
                      data-testid="submit-trade-proposal-btn"
                    >
                      Send Trade Proposal
                    </Button>
                  </div>
                </Card>
              </>
            )}
          </div>
        )}

        {/* Tab 2: Incoming Proposals */}
        {tab === 'INCOMING' && (
          <div className="space-y-3" data-testid="trade-incoming-list">
            {loading && incomingList.length === 0 ? (
              <p className="text-xs text-stadium-muted py-4 text-center">Loading incoming proposals...</p>
            ) : incomingList.length === 0 ? (
              <p className="text-xs text-stadium-muted py-4 text-center">No incoming trade proposals right now.</p>
            ) : (
              incomingList.map((t) => (
                <Card key={t.id} highlight="electric" className="p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-bold text-white">
                      From {t.proposerFranchiseDisplayName} ({t.proposerOwnerName})
                    </span>
                    <Badge tone="gold">PENDING</Badge>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-stadium-bg/75 border border-stadium-border p-2">
                      <p className="text-[10px] uppercase text-stadium-muted mb-1">You Receive</p>
                      {t.outgoingPlayers.map((p) => (
                        <p key={p.id} className="text-signal-sold font-semibold">
                          + {p.playerName} {p.isOverseas ? '(OS)' : ''}
                        </p>
                      ))}
                    </div>
                    <div className="rounded-lg bg-stadium-bg/75 border border-stadium-border p-2">
                      <p className="text-[10px] uppercase text-stadium-muted mb-1">You Send</p>
                      {t.incomingPlayers.map((p) => (
                        <p key={p.id} className="text-amber-300 font-semibold">
                          - {p.playerName} {p.isOverseas ? '(OS)' : ''}
                        </p>
                      ))}
                    </div>
                  </div>
                  {t.note && <p className="text-[11px] italic text-stadium-muted">&ldquo;{t.note}&rdquo;</p>}
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={actingId === t.id}
                      onClick={() => handleRespond(t, 'reject')}
                      data-testid={`reject-trade-${t.id}`}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="gold"
                      size="sm"
                      disabled={!allowPlayerTrades || actingId === t.id}
                      isLoading={actingId === t.id}
                      onClick={() => handleRespond(t, 'accept')}
                      data-testid={`accept-trade-${t.id}`}
                    >
                      Accept Swap
                    </Button>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {/* Tab 3: Outgoing Proposals */}
        {tab === 'OUTGOING' && (
          <div className="space-y-3" data-testid="trade-outgoing-list">
            {outgoingList.length === 0 ? (
              <p className="text-xs text-stadium-muted py-4 text-center">No outgoing pending proposals.</p>
            ) : (
              outgoingList.map((t) => (
                <Card key={t.id} className="p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-bold text-white">
                      To {t.receiverFranchiseDisplayName} ({t.receiverOwnerName})
                    </span>
                    <Badge tone="electric">
                      <Clock className="w-3 h-3" /> AWAITING RESPONSE
                    </Badge>
                  </div>
                  <p className="text-xs text-stadium-muted">
                    Sending: <strong className="text-white">{t.outgoingPlayers.map((p) => p.playerName).join(', ')}</strong>
                    {' ↔ '}
                    Requesting: <strong className="text-white">{t.incomingPlayers.map((p) => p.playerName).join(', ')}</strong>
                  </p>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      isLoading={actingId === t.id}
                      onClick={() => handleRespond(t, 'cancel')}
                      data-testid={`cancel-trade-${t.id}`}
                    >
                      Cancel Proposal
                    </Button>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {/* Tab 4: History */}
        {tab === 'HISTORY' && (
          <div className="space-y-2.5" data-testid="trade-history-list">
            {historyList.length === 0 ? (
              <p className="text-xs text-stadium-muted py-4 text-center flex items-center justify-center gap-1.5">
                <History className="w-3.5 h-3.5" /> No completed or closed trades yet.
              </p>
            ) : (
              historyList.map((t) => (
                <Card key={t.id} className="p-3 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-white">
                      {t.proposerFranchiseDisplayName} ↔ {t.receiverFranchiseDisplayName}
                    </span>
                    <Badge tone={t.status === 'ACCEPTED' ? 'sold' : 'unsold'}>{t.status}</Badge>
                  </div>
                  <p className="text-[11px] text-stadium-muted">
                    {t.proposerFranchiseCode}: {t.outgoingPlayers.map((p) => p.playerName).join(', ')}
                    {' ↔ '}
                    {t.receiverFranchiseCode}: {t.incomingPlayers.map((p) => p.playerName).join(', ')}
                  </p>
                  {t.failureReason && (
                    <p className="text-[10px] text-stadium-muted/80">{t.failureReason}</p>
                  )}
                </Card>
              ))
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
