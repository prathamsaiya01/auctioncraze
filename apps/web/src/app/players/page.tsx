'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CricketRole,
  CsvImportReportDto,
  MasterPlayerCatalogDto,
  PlayerImportBatchDto
} from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { formatLakhs } from '@/lib/formatPrice';
import { useSessionStore } from '@/stores/sessionStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PlayerProfileModal } from '@/components/players/PlayerProfileModal';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  FileSpreadsheet,
  Globe,
  RotateCcw,
  Search,
  ShieldCheck,
  Upload,
  User,
  XCircle
} from 'lucide-react';

interface CatalogMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  seasonsAvailable: number[];
  totalSeasonRecords: number;
}

const ROLE_LABELS: Record<CricketRole, string> = {
  BATSMAN: 'Batsman',
  BOWLER: 'Bowler',
  ALL_ROUNDER: 'All-Rounder',
  WICKET_KEEPER: 'Wicketkeeper'
};

const TEAM_FILTERS = [
  'CSK',
  'MI',
  'RCB',
  'KKR',
  'DC',
  'PBKS',
  'RR',
  'SRH',
  'GT',
  'LSG',
  'DCH',
  'GL',
  'PWI',
  'RPS',
  'KTK'
];

const SAMPLE_PLAYERS_CSV = `fullName,nationality,playingRole,battingStyle,bowlingStyle,iplDebutYear,basePriceLakhs
Virat Kohli,India,BATSMAN,RIGHT_HAND,RIGHT_ARM_MEDIUM,2008,200`;

const SAMPLE_SEASONS_CSV = `fullName,season,teamCode,matches,battingInnings,runs,ballsFaced,notOuts,highestScore,highestScoreText,battingAverage,strikeRate,fifties,hundreds
Virat Kohli,2026,RCB,14,14,550,375,2,92,92*,45.83,146.67,5,0`;

export default function PlayerCatalogPage() {
  const { session, token, isHydrated, hydrate, ensureSession } = useSessionStore();

  const [tab, setTab] = useState<'CATALOG' | 'IMPORT'>('CATALOG');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<string>('');
  const [overseas, setOverseas] = useState<string>('');
  const [team, setTeam] = useState<string>('');
  const [season, setSeason] = useState<string>('');
  const [sort, setSort] = useState<string>('runs');
  const [page, setPage] = useState(1);

  const [players, setPlayers] = useState<MasterPlayerCatalogDto[]>([]);
  const [meta, setMeta] = useState<CatalogMeta>({
    total: 0,
    page: 1,
    limit: 24,
    totalPages: 1,
    seasonsAvailable: [],
    totalSeasonRecords: 0
  });
  const [isLoading, setIsLoading] = useState(true);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);

  // Import state
  const [importMode, setImportMode] = useState<'PLAYERS' | 'SEASONS'>('PLAYERS');
  const [sourceName, setSourceName] = useState('custom_verified_csv');
  const [provenanceNotes, setProvenanceNotes] = useState('');
  const [csvText, setCsvText] = useState('');
  const [previewReport, setPreviewReport] = useState<CsvImportReportDto | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [batches, setBatches] = useState<PlayerImportBatchDto[]>([]);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const fetchCatalog = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '24');
      params.set('sort', sort);
      if (search.trim()) params.set('search', search.trim());
      if (role) params.set('role', role);
      if (overseas) params.set('overseas', overseas);
      if (team) params.set('team', team);
      if (season) params.set('season', season);

      const res: any = await api.get(`/players/catalog?${params.toString()}`);
      setPlayers(res.data || []);
      if (res.meta) setMeta(res.meta);
    } finally {
      setIsLoading(false);
    }
  }, [page, sort, search, role, overseas, team, season]);

  const fetchBatches = useCallback(async () => {
    try {
      const res: any = await api.get('/players/import/batches');
      setBatches(res.data || []);
    } catch {
      // ignore fetch error
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      fetchCatalog();
    }, 150);
    return () => clearTimeout(t);
  }, [fetchCatalog]);

  useEffect(() => {
    if (tab === 'IMPORT') {
      fetchBatches();
    }
  }, [tab, fetchBatches]);

  const ensureAuth = async () => {
    if (!token || !session) {
      await ensureSession('Data Curator');
    }
  };

  const handlePreview = async () => {
    setImportError(null);
    setImportSuccess(null);
    setIsImporting(true);
    try {
      await ensureAuth();
      const res: any = await api.post('/players/import/preview', {
        importMode,
        csvText,
        sourceName,
        provenanceNotes: provenanceNotes || undefined
      });
      setPreviewReport(res.data as CsvImportReportDto);
    } catch (err: any) {
      setImportError(err?.message || 'Preview failed.');
      setPreviewReport(null);
    } finally {
      setIsImporting(false);
    }
  };

  const handleCommit = async () => {
    setImportError(null);
    setImportSuccess(null);
    setIsImporting(true);
    try {
      await ensureAuth();
      const res: any = await api.post('/players/import/commit', {
        importMode,
        csvText,
        sourceName,
        provenanceNotes: provenanceNotes || undefined
      });
      const batch = res.data?.batch as PlayerImportBatchDto;
      setImportSuccess(
        `Imported batch cleanly (${batch.insertedCount} inserted, ${batch.updatedCount} updated).`
      );
      setPreviewReport(res.data?.report || null);
      fetchBatches();
      fetchCatalog();
    } catch (err: any) {
      setImportError(err?.message || 'Commit failed.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleRollback = async (batchId: string) => {
    setImportError(null);
    setImportSuccess(null);
    try {
      await ensureAuth();
      await api.post(`/players/import/batches/${batchId}/rollback`, {});
      setImportSuccess('Import batch rolled back cleanly.');
      fetchBatches();
      fetchCatalog();
    } catch (err: any) {
      setImportError(err?.message || 'Rollback failed.');
    }
  };

  return (
    <div className="min-h-screen bg-stadium-bg pb-12">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-stadium-border bg-stadium-bg/90 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="p-2 rounded-xl bg-stadium-surface border border-stadium-border text-stadium-muted hover:text-white transition-colors"
              aria-label="Back to Arena Home"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <h1 className="font-display text-2xl font-extrabold tracking-wide text-white leading-none">
                IPL PLAYER <span className="text-gold-400">ARCHIVE</span>
              </h1>
              <p className="text-[11px] text-stadium-muted mt-0.5">
                {meta.total > 0 ? `${meta.total} matched players` : 'Verifiable IPL Registry'} •{' '}
                {meta.totalSeasonRecords} season records (2008–2026)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={tab === 'CATALOG' ? 'gold' : 'surface'}
              size="sm"
              onClick={() => setTab('CATALOG')}
              leftIcon={<Search className="w-3.5 h-3.5" />}
            >
              Player Catalog
            </Button>
            <Button
              variant={tab === 'IMPORT' ? 'gold' : 'surface'}
              size="sm"
              onClick={() => setTab('IMPORT')}
              leftIcon={<FileSpreadsheet className="w-3.5 h-3.5" />}
              data-testid="csv-import-tab-btn"
            >
              CSV Import & Provenance
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 pt-6 space-y-6">
        {tab === 'CATALOG' ? (
          <>
            {/* Search & Filter Toolbar */}
            <Card className="p-4 sm:p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-4">
                  <Input
                    label="Search Player / Country / ID"
                    placeholder="e.g. Virat Kohli, West Indies, Rashid..."
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    data-testid="catalog-search-input"
                  />
                </div>

                <div className="md:col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Role
                  </label>
                  <select
                    value={role}
                    onChange={(e) => {
                      setRole(e.target.value);
                      setPage(1);
                    }}
                    className="w-full rounded-xl bg-stadium-surface/90 border border-stadium-border px-3 py-2.5 text-sm text-white focus:outline-none focus:border-gold-400"
                    data-testid="catalog-role-filter"
                  >
                    <option value="">All Roles</option>
                    <option value="BATSMAN">Batsman</option>
                    <option value="BOWLER">Bowler</option>
                    <option value="ALL_ROUNDER">All-Rounder</option>
                    <option value="WICKET_KEEPER">Wicketkeeper</option>
                  </select>
                </div>

                <div className="md:col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Origin
                  </label>
                  <select
                    value={overseas}
                    onChange={(e) => {
                      setOverseas(e.target.value);
                      setPage(1);
                    }}
                    className="w-full rounded-xl bg-stadium-surface/90 border border-stadium-border px-3 py-2.5 text-sm text-white focus:outline-none focus:border-gold-400"
                    data-testid="catalog-overseas-filter"
                  >
                    <option value="">All Players</option>
                    <option value="false">Domestic (India)</option>
                    <option value="true">Overseas</option>
                  </select>
                </div>

                <div className="md:col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Franchise
                  </label>
                  <select
                    value={team}
                    onChange={(e) => {
                      setTeam(e.target.value);
                      setPage(1);
                    }}
                    className="w-full rounded-xl bg-stadium-surface/90 border border-stadium-border px-3 py-2.5 text-sm text-white focus:outline-none focus:border-gold-400"
                  >
                    <option value="">All Teams</option>
                    {TEAM_FILTERS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="md:col-span-2 space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Sort By
                  </label>
                  <select
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value);
                      setPage(1);
                    }}
                    className="w-full rounded-xl bg-stadium-surface/90 border border-stadium-border px-3 py-2.5 text-sm text-white focus:outline-none focus:border-gold-400"
                  >
                    <option value="runs">Career Runs</option>
                    <option value="wickets">Career Wickets</option>
                    <option value="matches">Career Matches</option>
                    <option value="basePrice">Base Price</option>
                    <option value="name">Name (A–Z)</option>
                  </select>
                </div>
              </div>

              {meta.seasonsAvailable.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-stadium-border">
                  <span className="text-[11px] uppercase tracking-wider text-stadium-muted">
                    Season Filter:
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSeason('');
                      setPage(1);
                    }}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors ${
                      !season
                        ? 'bg-gold-500/20 border-gold-400 text-gold-300 font-bold'
                        : 'bg-stadium-card border-stadium-border text-stadium-muted hover:text-white'
                    }`}
                  >
                    All
                  </button>
                  {meta.seasonsAvailable.slice(0, 12).map((yr) => (
                    <button
                      key={yr}
                      type="button"
                      onClick={() => {
                        setSeason(String(yr));
                        setPage(1);
                      }}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors ${
                        season === String(yr)
                          ? 'bg-gold-500/20 border-gold-400 text-gold-300 font-bold'
                          : 'bg-stadium-card border-stadium-border text-stadium-muted hover:text-white'
                      }`}
                    >
                      {yr}
                    </button>
                  ))}
                </div>
              )}
            </Card>

            {/* Grid Results */}
            {isLoading ? (
              <div className="py-16 text-center text-sm text-stadium-muted">
                Loading IPL player registry...
              </div>
            ) : players.length === 0 ? (
              <Card className="p-10 text-center space-y-2">
                <p className="font-display text-2xl font-bold text-white">NO MATCHING PLAYERS</p>
                <p className="text-sm text-stadium-muted">
                  Try clearing filters or searching another player or franchise.
                </p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {players.map((p) => (
                  <Card
                    key={p.id}
                    onClick={() => setSelectedPlayerId(p.id)}
                    data-testid={`player-card-${p.cricsheetId || p.id}`}
                    className="p-4 space-y-3 cursor-pointer hover:border-gold-500/50 transition-all"
                  >
                    <div className="flex items-start gap-3.5">
                      <div className="w-14 h-16 rounded-xl border border-gold-500/30 bg-stadium-card flex items-center justify-center overflow-hidden shrink-0">
                        {p.imageUrl ? (
                          <img
                            src={p.imageUrl}
                            alt={p.fullName}
                            className="w-full h-full object-cover object-top"
                          />
                        ) : (
                          <User className="w-6 h-6 text-gold-400" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <h3 className="font-display text-xl font-bold text-white truncate">
                          {p.fullName}
                        </h3>
                        <p className="text-xs text-stadium-muted flex items-center gap-1.5 mt-0.5">
                          <Globe className="w-3 h-3 text-electric-400 shrink-0" />
                          <span className="truncate">{p.nationality || 'Nationality Unknown'}</span>
                        </p>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          <Badge tone="gold">{ROLE_LABELS[p.playingRole]}</Badge>
                          <Badge tone={p.isOverseas ? 'electric' : 'sold'}>
                            {p.isOverseas ? 'Overseas' : 'Domestic'}
                          </Badge>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-2 pt-2 border-t border-stadium-border text-xs">
                      <div>
                        <p className="text-[10px] text-stadium-muted uppercase">Mats</p>
                        <p className="font-mono font-bold text-white">{p.careerMatches ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-stadium-muted uppercase">Runs</p>
                        <p className="font-mono font-bold text-gold-300">{p.careerRuns ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-stadium-muted uppercase">Wkts</p>
                        <p className="font-mono font-bold text-electric-400">{p.careerWickets ?? '—'}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-stadium-muted uppercase">Base</p>
                        <p className="font-mono font-bold text-white">{formatLakhs(p.basePriceLakhs)}</p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px] text-stadium-muted">
                      <span className="truncate">
                        {p.teamHistory.length > 0 ? p.teamHistory.join(' • ') : 'No team tag'}
                      </span>
                      <span className="font-mono shrink-0 text-gold-300">
                        {p.iplDebutYear ? `${p.iplDebutYear}–${p.iplLastYear || p.iplDebutYear}` : ''}
                      </span>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {/* Pagination */}
            {meta.totalPages > 1 && (
              <div className="flex items-center justify-between pt-2">
                <p className="text-xs text-stadium-muted font-mono">
                  Page {meta.page} of {meta.totalPages} ({meta.total} players)
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="surface"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    leftIcon={<ChevronLeft className="w-4 h-4" />}
                  >
                    Prev
                  </Button>
                  <Button
                    variant="surface"
                    size="sm"
                    disabled={page >= meta.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    leftIcon={<ChevronRight className="w-4 h-4" />}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          /* CSV DATA IMPORT & PROVENANCE TAB */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            <Card className="lg:col-span-7 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stadium-border pb-3">
                <div className="flex items-center gap-2">
                  <Upload className="w-4 h-4 text-gold-400" />
                  <h2 className="font-display text-xl font-bold text-white">
                    REUSABLE CSV IMPORT PIPELINE
                  </h2>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setCsvText(importMode === 'PLAYERS' ? SAMPLE_PLAYERS_CSV : SAMPLE_SEASONS_CSV);
                      setPreviewReport(null);
                    }}
                  >
                    Load Sample CSV
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Import Mode
                  </label>
                  <select
                    value={importMode}
                    onChange={(e) => {
                      setImportMode(e.target.value as 'PLAYERS' | 'SEASONS');
                      setPreviewReport(null);
                    }}
                    className="w-full rounded-xl bg-stadium-surface border border-stadium-border px-3 py-2.5 text-sm text-white"
                    data-testid="import-mode-select"
                  >
                    <option value="PLAYERS">Players Identity & Bio CSV</option>
                    <option value="SEASONS">Season-Wise Stats CSV</option>
                  </select>
                </div>

                <Input
                  label="Provenance Source Name"
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  placeholder="cricsheet_2027_update"
                />
              </div>

              <Input
                label="Provenance Notes (Optional)"
                value={provenanceNotes}
                onChange={(e) => setProvenanceNotes(e.target.value)}
                placeholder="Source URL, season scope, verification reference..."
              />

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    CSV Payload (Or Select Local File)
                  </label>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="text-xs text-stadium-muted"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const txt = await file.text();
                      setCsvText(txt);
                      setPreviewReport(null);
                    }}
                  />
                </div>
                <textarea
                  rows={8}
                  value={csvText}
                  onChange={(e) => {
                    setCsvText(e.target.value);
                    setPreviewReport(null);
                  }}
                  placeholder="Paste CSV headers and rows..."
                  className="w-full rounded-xl bg-stadium-bg border border-stadium-border p-3 font-mono text-xs text-white focus:outline-none focus:border-gold-400"
                  data-testid="csv-textarea"
                />
              </div>

              {importError && (
                <div className="rounded-xl border border-signal-unsold/45 bg-signal-unsold/15 px-3 py-2.5 text-xs text-white flex items-center gap-2">
                  <XCircle className="w-4 h-4 text-signal-unsold shrink-0" />
                  <span>{importError}</span>
                </div>
              )}
              {importSuccess && (
                <div className="rounded-xl border border-signal-sold/45 bg-signal-sold/15 px-3 py-2.5 text-xs text-white flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-signal-sold shrink-0" />
                  <span>{importSuccess}</span>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <Button
                  variant="surface"
                  onClick={handlePreview}
                  isLoading={isImporting || !isHydrated}
                  disabled={!csvText.trim()}
                  data-testid="preview-import-btn"
                >
                  Preview & Validate CSV
                </Button>
                <Button
                  variant="gold"
                  onClick={handleCommit}
                  isLoading={isImporting}
                  disabled={!previewReport?.canCommit}
                  data-testid="commit-import-btn"
                >
                  Commit Transactional Import
                </Button>
              </div>

              {previewReport && (
                <div className="rounded-xl border border-stadium-border bg-stadium-card/60 p-4 space-y-3" data-testid="import-preview-report">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-display text-lg font-bold text-white">PREVIEW SUMMARY</span>
                    <Badge tone={previewReport.canCommit ? 'sold' : 'unsold'}>
                      {previewReport.canCommit ? 'READY TO COMMIT' : 'VALIDATION BLOCKED'}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-xs font-mono">
                    <div>Inserts: <strong className="text-signal-sold">{previewReport.insertCount}</strong></div>
                    <div>Updates: <strong className="text-electric-400">{previewReport.updateCount}</strong></div>
                    <div>Duplicates: <strong className="text-signal-warn">{previewReport.duplicateCount}</strong></div>
                    <div>Errors: <strong className="text-signal-unsold">{previewReport.errorCount}</strong></div>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1.5 text-xs">
                    {previewReport.previewRows.map((r) => (
                      <div key={r.rowNumber} className="rounded-lg border border-stadium-border/70 bg-stadium-bg/70 px-2.5 py-1.5 flex items-center justify-between gap-2">
                        <span className="text-white truncate">
                          Row {r.rowNumber}: <strong>{r.identityLabel}</strong> — {r.summary}
                        </span>
                        <Badge tone={r.action === 'INSERT' ? 'sold' : r.action === 'UPDATE' ? 'electric' : 'unsold'}>
                          {r.action}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Right: Data Provenance & Audit Batches */}
            <aside className="lg:col-span-5 space-y-4">
              <Card highlight="gold" className="p-5 space-y-3">
                <div className="flex items-center gap-2 border-b border-stadium-border pb-2.5">
                  <Database className="w-4 h-4 text-gold-400" />
                  <h2 className="font-display text-xl font-bold text-white">DATA PROVENANCE</h2>
                </div>
                <ul className="space-y-2 text-xs text-stadium-muted leading-relaxed">
                  <li>
                    <strong className="text-white">Match & Ball-by-Ball Registry:</strong> Cricsheet Open IPL Archive (1,243 matches across 2008–2026 seasons; 809 players; 3,354 season records).
                  </li>
                  <li>
                    <strong className="text-white">Player Identities & Bios:</strong> Cricsheet Register (people.csv), Wikidata CC0 SPARQL (P2697), and Wikimedia Action API (Infobox cricketer template, CC-BY-SA).
                  </li>
                  <li>
                    <strong className="text-white">Missing Data Policy:</strong> Unrecorded averages, strike rates, bowling economies, and missing photos remain strictly `null` (`—`), never invented as zeroes.
                  </li>
                </ul>
              </Card>

              <Card className="p-5 space-y-3">
                <div className="flex items-center gap-2 border-b border-stadium-border pb-2.5">
                  <ShieldCheck className="w-4 h-4 text-electric-400" />
                  <h2 className="font-display text-xl font-bold text-white">IMPORT AUDIT LOG</h2>
                </div>
                <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                  {batches.length === 0 ? (
                    <p className="text-xs text-stadium-muted">No import batches recorded yet.</p>
                  ) : (
                    batches.map((b) => (
                      <div key={b.id} className="rounded-xl border border-stadium-border bg-stadium-card/60 p-3 space-y-1.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-white truncate">{b.sourceName}</span>
                          <Badge tone={b.status === 'COMMITTED' ? 'sold' : b.status === 'ROLLED_BACK' ? 'neutral' : 'unsold'}>
                            {b.status}
                          </Badge>
                        </div>
                        <p className="text-[11px] font-mono text-stadium-muted">
                          {b.importMode} • +{b.insertedCount} ins / {b.updatedCount} upd / {b.errorCount} err
                        </p>
                        {b.provenanceNotes && (
                          <p className="text-[11px] text-stadium-muted line-clamp-2">{b.provenanceNotes}</p>
                        )}
                        {b.status === 'COMMITTED' && b.importMode === 'PLAYERS' && b.insertedCount > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRollback(b.id)}
                            leftIcon={<RotateCcw className="w-3 h-3" />}
                          >
                            Rollback Batch
                          </Button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </Card>
            </aside>
          </div>
        )}
      </main>

      <PlayerProfileModal
        playerId={selectedPlayerId}
        onClose={() => setSelectedPlayerId(null)}
      />
    </div>
  );
}
