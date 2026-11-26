'use client';

import React, { useEffect, useState } from 'react';
import { ROOM_DEFAULTS } from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Check, Pencil, X } from 'lucide-react';

interface FranchiseNicknameEditorProps {
  roomCode: string;
  presetCode: string;
  currentSuffix: string | null;
  enabled: boolean;
  onUpdated?: () => void;
}

export function FranchiseNicknameEditor({
  roomCode,
  presetCode,
  currentSuffix,
  enabled,
  onUpdated
}: FranchiseNicknameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentSuffix || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(currentSuffix || '');
  }, [currentSuffix]);

  if (!enabled) {
    return null;
  }

  const handleSave = async (nextVal: string | null) => {
    setError(null);
    setSaving(true);
    try {
      await api.patch(`/rooms/${roomCode}/franchise/nickname`, {
        customSuffix: nextVal
      });
      setEditing(false);
      onUpdated?.();
    } catch (err: any) {
      setError(err?.message || 'Unable to save nickname');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-2 mt-1.5">
        <button
          type="button"
          onClick={() => setEditing(true)}
          data-testid={`edit-nickname-btn-${presetCode}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gold-500/35 bg-gold-500/10 px-2.5 py-1 text-[11px] font-semibold text-gold-300 hover:bg-gold-500/20 transition-colors"
        >
          <Pencil className="w-3 h-3" />
          {currentSuffix ? `Nickname: ${currentSuffix}` : 'Add Custom Nickname'}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-gold-300 font-bold">{presetCode} —</span>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={ROOM_DEFAULTS.CUSTOM_TEAM_NAME_MAX_LENGTH}
          placeholder="e.g. Hard Hitters"
          data-testid={`nickname-input-${presetCode}`}
          className="flex-1 min-w-[140px] rounded-lg bg-stadium-bg border border-stadium-border px-2.5 py-1 text-xs text-white focus:outline-none focus:border-gold-400"
        />
        <Button
          size="sm"
          variant="gold"
          isLoading={saving}
          onClick={() => handleSave(value.trim())}
          data-testid={`save-nickname-btn-${presetCode}`}
          leftIcon={<Check className="w-3 h-3" />}
        >
          Save
        </Button>
        {currentSuffix && (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => handleSave(null)}
            data-testid={`clear-nickname-btn-${presetCode}`}
          >
            Clear
          </Button>
        )}
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
            setValue(currentSuffix || '');
          }}
          className="p-1 text-stadium-muted hover:text-white"
          aria-label="Cancel nickname edit"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {error && <p className="text-[11px] text-signal-unsold">{error}</p>}
    </div>
  );
}
