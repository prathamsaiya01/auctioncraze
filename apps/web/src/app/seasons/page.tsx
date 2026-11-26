'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { SeasonStatus, SeasonSummaryDto } from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { useSessionStore } from '@/stores/sessionStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ArrowLeft, ArrowRight, Calendar, PlusCircle, Trophy } from 'lucide-react';

export default function SeasonsHubPage() {
  const router = useRouter();
  const { session, hydrate, ensureSession } = useSessionStore();

  const [displayName, setDisplayName] = useState('');
  const [seasonName, setSeasonName] = useState('AuctionCraze Premier Season 2026');
  const [year, setYear] = useState<number>(2026);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [description, setDescription] = useState('');

  const [joinSeasonCode, setJoinSeasonCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (session?.displayName && !displayName) {
      setDisplayName(session.displayName);
    }
  }, [session?.displayName, displayName]);

  const { data: seasons = [], isLoading } = useQuery({
    queryKey: ['seasons-list'],
    queryFn: async () => {
      const res: any = await api.get('/seasons');
      return (res?.data || []) as SeasonSummaryDto[];
    },
    refetchInterval: 20_000
  });

  const handleCreateSeason = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmedHost = displayName.trim();
    if (trimmedHost.length < 2) {
      setFormError('Enter your display name (at least 2 characters) — no login required.');
      return;
    }
    setIsCreating(true);
    try {
      await ensureSession(trimmedHost);
      const res: any = await api.post('/seasons', {
        name: seasonName.trim(),
        year: Number(year),
        description: description.trim() || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        displayName: trimmedHost
      });
      const created = res.data;
      router.push(`/seasons/${created.code}`);
    } catch (err: any) {
      setFormError(err?.message || 'Unable to create season.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenByCode = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = joinSeasonCode.trim().toUpperCase();
    if (!clean) return;
    router.push(`/seasons/${encodeURIComponent(clean)}`);
  };

  return (
    <div className="min-h-screen bg-stadium-bg pb-16">
      <header className="sticky top-0 z-30 border-b border-stadium-border bg-stadium-bg/85 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="p-2 rounded-lg text-stadium-muted hover:text-white hover:bg-white/5"
              aria-label="Back to home"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <h1 className="font-display text-2xl font-extrabold tracking-wide text-white flex items-center gap-2">
                <Trophy className="w-5 h-5 text-gold-400" />
                SEASON MANAGEMENT &amp; LEADERBOARDS
              </h1>
              <p className="text-[11px] text-stadium-muted hidden sm:block">
                Organize multi-month auction series with login-free franchise identities and live season points.
              </p>
            </div>
          </div>

          <Link href="/">
            <Button variant="surface" size="sm">
              Quick Room Arena
            </Button>
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Create Season Card (Host, No Login Required) */}
          <Card highlight="gold" className="lg:col-span-7 p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-stadium-border pb-3">
              <div>
                <h2 className="font-display text-2xl font-bold text-white flex items-center gap-2">
                  <PlusCircle className="w-5 h-5 text-gold-400" />
                  CREATE A SEASON
                </h2>
                <p className="text-xs text-stadium-muted mt-0.5">
                  No email, password, or OTP required. Host monthly auctions and track cumulative franchise points.
                </p>
              </div>
              <Badge tone="gold">LOGIN-FREE</Badge>
            </div>

            <form onSubmit={handleCreateSeason} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="Host Display Name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. CommissionerVikram"
                  data-testid="season-host-name-input"
                  required
                />
                <Input
                  label="Season Name"
                  value={seasonName}
                  onChange={(e) => setSeasonName(e.target.value)}
                  placeholder="e.g. AuctionCraze Season 2026"
                  data-testid="season-name-input"
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Input
                  label="Season Year"
                  type="number"
                  min={2008}
                  max={2100}
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                  data-testid="season-year-input"
                  required
                />
                <Input
                  label="Start Date (Optional)"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  data-testid="season-start-input"
                />
                <Input
                  label="End Date (Optional)"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  data-testid="season-end-input"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted mb-1.5">
                  Season Description (Optional)
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={280}
                  rows={2}
                  data-testid="season-description-input"
                  placeholder="Monthly IPL auction championship across Nov–Feb..."
                  className="w-full rounded-xl bg-stadium-bg border border-stadium-border px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-gold-400"
                />
              </div>

              {formError && (
                <p className="text-xs text-signal-unsold bg-signal-unsold/10 border border-signal-unsold/30 rounded-xl px-3 py-2">
                  {formError}
                </p>
              )}

              <Button
                type="submit"
                variant="gold"
                isLoading={isCreating}
                data-testid="create-season-submit-btn"
              >
                Launch Season Hub
              </Button>
            </form>
          </Card>

          {/* Join / Lookup Season by Code + Active/Archived Seasons */}
          <div className="lg:col-span-5 space-y-5">
            <Card highlight="electric" className="p-6 space-y-4">
              <h2 className="font-display text-xl font-bold text-white">JOIN WITH SEASON CODE</h2>
              <p className="text-xs text-stadium-muted">
                Enter your league&apos;s season code (e.g. <span className="font-mono text-electric-300">SZN-26-XXXX</span>) to claim your franchise identity and view live standings.
              </p>
              <form onSubmit={handleOpenByCode} className="flex items-center gap-2">
                <input
                  type="text"
                  value={joinSeasonCode}
                  onChange={(e) => setJoinSeasonCode(e.target.value.toUpperCase())}
                  placeholder="SZN-26-XXXX"
                  data-testid="join-season-code-input"
                  className="flex-1 rounded-xl bg-stadium-bg border border-stadium-border px-3.5 py-2.5 text-sm font-mono uppercase text-white focus:outline-none focus:border-electric-400"
                />
                <Button type="submit" variant="electric" data-testid="join-season-submit-btn">
                  Open <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </form>
            </Card>

            <Card className="p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-stadium-border pb-2.5">
                <h2 className="font-display text-lg font-bold text-white flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-gold-400" />
                  RECENT SEASONS
                </h2>
                <span className="text-xs font-mono text-stadium-muted">{seasons.length} total</span>
              </div>

              {isLoading ? (
                <p className="text-xs text-stadium-muted py-4 text-center">Loading seasons...</p>
              ) : seasons.length === 0 ? (
                <p className="text-xs text-stadium-muted py-4 text-center">
                  No seasons created yet. Create the first season to get started!
                </p>
              ) : (
                <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
                  {seasons.map((s) => (
                    <Link
                      key={s.id}
                      href={`/seasons/${s.code}`}
                      data-testid={`season-card-${s.code}`}
                      className="block rounded-xl border border-stadium-border bg-stadium-card/70 hover:border-gold-400/50 p-3.5 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display font-bold text-base text-white truncate">
                          {s.name}
                        </span>
                        <Badge tone={s.status === SeasonStatus.ACTIVE ? 'sold' : 'neutral'}>
                          {s.status}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs text-stadium-muted mt-1.5 font-mono">
                        <span className="text-gold-300">{s.code} • {s.year}</span>
                        <span>
                          {s.auctionCount} auctions • {s.claimedFranchisesCount}/10 franchises
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
