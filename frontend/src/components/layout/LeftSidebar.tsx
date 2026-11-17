import { Clock, FolderKanban, Home, Layers, Settings } from 'lucide-react';
import type { NavSection } from './TopNav';

interface LeftSidebarProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
  userModelCount: number;
  activeJobRunning: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: readonly {
  id: NavSection;
  label: string;
  Icon: typeof Home;
}[] = [
  { id: 'home', label: 'Home', Icon: Home },
  { id: 'create', label: 'Create', Icon: Layers },
  { id: 'models', label: 'My Models', Icon: FolderKanban },
  { id: 'history', label: 'History', Icon: Clock },
  { id: 'settings', label: 'Settings', Icon: Settings },
];

export function LeftSidebar({
  activeSection,
  onNavigate,
  userModelCount,
  activeJobRunning,
  mobileOpen,
  onCloseMobile,
}: LeftSidebarProps) {
  const renderNav = (expanded: boolean) => (
    <nav aria-label="Studio navigation" className="flex h-full flex-col justify-between py-3">
      <div className="space-y-1 px-2">
        {NAV_ITEMS.map(({ id, label, Icon }) => {
          const active = activeSection === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                onNavigate(id);
                onCloseMobile();
              }}
              className={`group relative flex w-full items-center rounded-lg transition ${
                expanded
                  ? 'gap-3 px-3 py-2.5 text-left text-xs font-medium'
                  : 'flex-col gap-1 px-1.5 py-2.5 text-[10px] font-medium'
              } ${
                active
                  ? 'bg-[#76b900]/14 text-white'
                  : 'text-[#8d97ab] hover:bg-[#171d28] hover:text-[#e6eaf2]'
              }`}
            >
              {active && (
                <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r bg-[#8ed90b]" />
              )}
              <Icon
                className={`h-4 w-4 shrink-0 transition ${
                  active ? 'text-[#8ed90b]' : 'text-[#7e899f] group-hover:text-[#cfd6e4]'
                }`}
              />
              <span className="leading-none">{label}</span>

              {id === 'create' && activeJobRunning && (
                <span
                  title="Generation job running"
                  className="absolute top-2 right-2 h-2 w-2 animate-pulse rounded-full bg-[#8ed90b]"
                />
              )}

              {id === 'models' && userModelCount > 0 && expanded && (
                <span className="ml-auto rounded bg-[#1d2433] px-1.5 py-0.5 font-mono-tech text-[10px] text-[#aeb7c9]">
                  {userModelCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {expanded && (
        <div className="mx-3 rounded-lg border border-[#1f2634] bg-[#121722] p-3 text-[11px] text-[#838ea4]">
          <p className="font-semibold text-[#cfd6e4]">NV3D Studio v1.0</p>
          <p className="mt-0.5">GLB 2.0 + NIM MiniMax Pipeline</p>
        </div>
      )}
    </nav>
  );

  return (
    <>
      {/* Desktop Slim Studio Rail */}
      <aside className="hidden w-[74px] shrink-0 border-r border-[#1f2634] bg-[#0e1118] lg:block">
        {renderNav(false)}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 top-13 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 top-13 bg-black/65 backdrop-blur-[2px]"
            onClick={onCloseMobile}
          />
          <aside className="relative z-10 w-60 border-r border-[#232b3c] bg-[#0e1118] shadow-2xl">
            {renderNav(true)}
          </aside>
        </div>
      )}
    </>
  );
}
