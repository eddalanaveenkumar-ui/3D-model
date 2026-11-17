import { Cpu, KeyRound, Menu, X } from 'lucide-react';
import type { SystemStatus } from '@nv3d/shared';
import { maskNvidiaApiKey } from '../../lib/nimKeyStore';
import { BrandLogo } from './BrandLogo';

export type NavSection = 'home' | 'create' | 'models' | 'history' | 'settings';

interface TopNavProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  systemStatus: SystemStatus | null;
  storedNimKey: string;
  onOpenApiKey: () => void;
  mobileMenuOpen: boolean;
  onToggleMobileMenu: () => void;
}

export function TopNav({
  onNavigate,
  systemStatus,
  storedNimKey,
  onOpenApiKey,
  mobileMenuOpen,
  onToggleMobileMenu,
}: TopNavProps) {
  const isDemoMode = systemStatus ? systemStatus.demoMode : !storedNimKey;
  const activeProviderName = systemStatus?.activeProvider?.displayName ?? 'NVIDIA NIM 3D';
  const hasBrowserKey = storedNimKey.length > 0;
  const nimReady = hasBrowserKey || Boolean(systemStatus?.nim.configured);

  return (
    <header className="z-30 flex h-13 shrink-0 items-center justify-between border-b border-[#1f2634] bg-[#0d1017] px-3 sm:px-4">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onToggleMobileMenu}
          aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#222a3a] bg-[#141923] text-[#aeb7c9] transition hover:text-white lg:hidden"
        >
          {mobileMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>

        <button
          type="button"
          onClick={() => onNavigate('home')}
          className="rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#76b900]"
        >
          <BrandLogo />
        </button>
      </div>

      {/* Right Pipeline Status & Browser LocalStorage NVIDIA API Key Button (No Login Required) */}
      <div className="flex items-center gap-2 sm:gap-2.5">
        {systemStatus && (
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            title={
              isDemoMode
                ? 'Demo Mode: Add your NVIDIA NIM API key to enable live generation.'
                : `Active 3D provider: ${activeProviderName}. Click to open pipeline diagnostics.`
            }
            className={`hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition sm:flex ${
              isDemoMode
                ? 'border-amber-500/35 bg-amber-500/10 text-amber-300 hover:bg-amber-500/16'
                : 'border-[#76b900]/40 bg-[#76b900]/12 text-[#a3e635] hover:bg-[#76b900]/20'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isDemoMode ? 'bg-amber-400' : 'bg-[#8ed90b]'
              }`}
            />
            <span>{isDemoMode ? 'Demo Mode' : `${activeProviderName}`}</span>
          </button>
        )}

        {systemStatus && (
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            title={`NVIDIA NIM (${systemStatus.nim.modelId}): ${
              nimReady ? 'Active' : 'API key not set'
            }`}
            className="hidden items-center gap-1.5 rounded-lg border border-[#222a3a] bg-[#131721] px-2.5 py-1.5 text-[11px] text-[#9aa4b8] transition hover:border-[#313c52] hover:text-white md:flex"
          >
            <Cpu className={`h-3.5 w-3.5 ${nimReady ? 'text-[#8ed90b]' : 'text-[#6c778d]'}`} />
            <span>MiniMax M3.1</span>
          </button>
        )}

        {/* Primary Frontend NVIDIA NIM API Key Button */}
        <button
          type="button"
          onClick={onOpenApiKey}
          title={
            hasBrowserKey
              ? `NVIDIA NIM key stored in browser localStorage (${maskNvidiaApiKey(storedNimKey)}). Click to manage.`
              : 'Paste your NVIDIA NIM API key (stored locally in your browser — no login required)'
          }
          className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
            hasBrowserKey
              ? 'border-[#76b900]/45 bg-[#141b12] text-[#d8f3a2] hover:border-[#8ed90b] hover:text-white'
              : nimReady
              ? 'border-[#232b3c] bg-[#141923] text-[#d8deea] hover:border-[#344057] hover:text-white'
              : 'border-[#76b900] bg-[#76b900] text-[#080d03] hover:bg-[#8ed90b]'
          }`}
        >
          <KeyRound className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden sm:inline">
            {hasBrowserKey
              ? maskNvidiaApiKey(storedNimKey)
              : nimReady
              ? 'NVIDIA API Key'
              : 'Set NVIDIA API Key'}
          </span>
          <span className="sm:hidden">{hasBrowserKey ? 'Key Saved' : 'API Key'}</span>
        </button>
      </div>
    </header>
  );
}
