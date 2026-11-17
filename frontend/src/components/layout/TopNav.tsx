import { Coins, Cpu, Menu, User, X } from 'lucide-react';
import type { SystemStatus, UserProfile } from '@nv3d/shared';
import { BrandLogo } from './BrandLogo';

export type NavSection = 'home' | 'create' | 'models' | 'history' | 'settings';

interface TopNavProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  systemStatus: SystemStatus | null;
  user: UserProfile | null;
  onOpenAuth: () => void;
  mobileMenuOpen: boolean;
  onToggleMobileMenu: () => void;
}

export function TopNav({
  onNavigate,
  systemStatus,
  user,
  onOpenAuth,
  mobileMenuOpen,
  onToggleMobileMenu,
}: TopNavProps) {
  const isDemoMode = systemStatus ? systemStatus.demoMode : true;
  const activeProviderName = systemStatus?.activeProvider?.displayName;
  const initials = user?.displayName
    ? user.displayName
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() || '')
        .join('')
    : 'NV';

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

      {/* Right Status, Credits & Profile */}
      <div className="flex items-center gap-2 sm:gap-2.5">
        {systemStatus && (
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            title={
              isDemoMode
                ? 'Demo Mode: No 3D generation provider key configured. Click to open Settings.'
                : `Active 3D provider: ${activeProviderName}. Click to inspect pipeline status.`
            }
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
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
            <span className="hidden sm:inline">
              {isDemoMode ? 'Demo Mode' : `${activeProviderName} Live`}
            </span>
            <span className="sm:hidden">{isDemoMode ? 'Demo' : 'Live'}</span>
          </button>
        )}

        {systemStatus && (
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            title={`NVIDIA NIM (${systemStatus.nim.modelId}): ${
              systemStatus.nim.configured ? 'Configured' : 'API key not set'
            }`}
            className="hidden items-center gap-1.5 rounded-lg border border-[#222a3a] bg-[#131721] px-2.5 py-1.5 text-[11px] text-[#9aa4b8] transition hover:border-[#313c52] hover:text-white md:flex"
          >
            <Cpu
              className={`h-3.5 w-3.5 ${
                systemStatus.nim.configured ? 'text-[#8ed90b]' : 'text-[#6c778d]'
              }`}
            />
            <span>MiniMax M3.1</span>
          </button>
        )}

        {/* User Credits */}
        <button
          type="button"
          onClick={() => onNavigate('settings')}
          title="Available generation credits"
          className="flex items-center gap-1.5 rounded-lg border border-[#232b3c] bg-[#141923] px-2.5 py-1.5 text-xs font-medium text-[#e6eaf2] transition hover:border-[#344057]"
        >
          <Coins className="h-3.5 w-3.5 text-[#8ed90b]" />
          <span className="font-mono-tech">{user ? user.credits : '--'}</span>
          <span className="hidden text-[10px] font-semibold tracking-wider text-[#7e89a0] uppercase sm:inline">
            CR
          </span>
        </button>

        {/* User Profile */}
        <button
          type="button"
          onClick={onOpenAuth}
          className="flex items-center gap-2 rounded-lg border border-[#232b3c] bg-[#141923] py-1 pr-2.5 pl-1.5 text-xs font-medium text-[#d8deea] transition hover:border-[#344057] hover:text-white"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#76b900]/20 text-[10px] font-bold text-[#a3e635]">
            {user ? initials : <User className="h-3.5 w-3.5" />}
          </span>
          <span className="hidden max-w-[116px] truncate sm:inline">
            {user ? (user.isGuest ? 'Sign In' : user.displayName) : 'Account'}
          </span>
        </button>
      </div>
    </header>
  );
}
